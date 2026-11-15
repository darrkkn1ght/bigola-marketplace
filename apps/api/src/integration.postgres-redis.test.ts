import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient, UserRole } from "@prisma/client";
import { QueueEvents } from "bullmq";
import { buildApp } from "./app.js";
import { loadIsolatedTestEnv } from "./lib/test-isolation.js";
import { hashPassword } from "./lib/crypto.js";
import { createBullMqConnection, createBullMqWorker, createQueueInfrastructure } from "./lib/redis.js";
import { createPrismaStores } from "./lib/repositories.js";

const RUN_INFRA = process.env.RUN_INFRA_TESTS === "true";

describe("Cloud Infrastructure Integration (Neon PostgreSQL + Upstash Redis + BullMQ)", { skip: !RUN_INFRA }, () => {
  it("verifies Neon DB, seed topology, Upstash TLS Redis, BullMQ job processing, RBAC, and audit persistence", async () => {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Refusing to run integration tests against NODE_ENV=production.");
    }

    const env = loadIsolatedTestEnv();
    assert.equal(env.DISBURSEMENT_ENABLED, false, "DISBURSEMENT_ENABLED must remain false.");
    assert.ok(env.REDIS_URL, "REDIS_URL is required for cloud infrastructure tests.");

    const prisma = new PrismaClient();
    const stores = createPrismaStores(prisma);
    const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);

    const app = await buildApp({
      env,
      authStore: stores.authStore,
      auditStore: stores.auditStore,
      platformStore: stores.platformStore,
      queues,
      async checkDb() {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      },
    });

    let queueEventsConn: ReturnType<typeof createBullMqConnection> | null = null;
    let queueEvents: QueueEvents | null = null;
    let worker: ReturnType<typeof createBullMqWorker> | null = null;
    let createdUserId: string | null = null;

    try {
      // 1. Health check confirms live Neon Postgres & isolated Redis
      const health = await app.inject({ method: "GET", url: "/api/v1/health" });
      assert.equal(health.statusCode, 200);
      assert.equal(health.json().dependencies.postgres, "connected");
      assert.equal(health.json().dependencies.redis, "connected");
      assert.equal(health.json().disbursementEnabled, false);

      // 2. Verify BullMQ job creation & processing over isolated Redis
      queueEventsConn = createBullMqConnection(env.REDIS_URL);
      queueEvents = new QueueEvents("infra-health", {
        connection: queueEventsConn,
        prefix: env.QUEUE_PREFIX,
      });
      worker = createBullMqWorker(
        "infra-health",
        env.REDIS_URL,
        env.QUEUE_PREFIX,
        async (job) => ({ echo: job.data.ping, processed: true })
      );

      const job = await queues.infraHealthQueue!.add("cloud-verify", { ping: "pong" });
      const result = await job.waitUntilFinished(queueEvents, 15_000);
      assert.deepEqual(result, { echo: "pong", processed: true });

      // 3. Verify seeded topology & rules
      const accounts = await stores.platformStore.getGameAccounts();
      const treasury = accounts.find((a) => a.slotCode === "MAIN_TREASURY");
      const reserves = accounts.filter((a) => a.accountRole === "RESERVE");
      assert.equal(treasury?.lagoslifeUsername, "bigola2823");
      assert.equal(reserves.length, 4);
      for (const r of reserves) {
        assert.equal(r.targetReserveAmount, "70000000000000");
      }

      const rules = await stores.platformStore.getCommissionRules();
      const catA = rules.find((r) => r.category === "CATEGORY_A_PARTNER");
      const catB = rules.find((r) => r.category === "CATEGORY_B_BIGOLA");
      assert.equal(catA?.partnerShareBps, 5000);
      assert.equal(catA?.ownerShareBps, 5000);
      assert.equal(catB?.status, "PENDING_RULE");
      assert.equal(catB?.partnerShareBps, null);

      // 4. Verify unique email constraint, RBAC enforcement & audit log persistence in Neon
      const testEmail = `cloud_test_${Date.now()}@example.com`;
      const user = await stores.authStore.createUser({
        email: testEmail,
        passwordHash: await hashPassword("CloudTestPass#2026"),
        role: UserRole.CUSTOMER,
      });
      createdUserId = user.id;
      await assert.rejects(
        stores.authStore.createUser({
          email: testEmail,
          passwordHash: await hashPassword("CloudTestPass#2026"),
          role: UserRole.CUSTOMER,
        })
      );

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: testEmail, password: "CloudTestPass#2026" },
      });
      assert.equal(loginRes.statusCode, 200);
      const token = loginRes.json().token as string;

      const ownerDenied = await app.inject({
        method: "GET",
        url: "/api/v1/owner/overview",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(ownerDenied.statusCode, 403);

      const persistedLogs = await prisma.auditLog.findMany({ where: { actorUserId: user.id } });
      assert.ok(persistedLogs.some((l) => l.actionType === "USER_LOGIN_SUCCEEDED"));
    } finally {
      if (createdUserId) {
        await Promise.allSettled([
          prisma.userSession.deleteMany({ where: { userId: createdUserId } }),
          prisma.auditLog.deleteMany({ where: { actorUserId: createdUserId } }),
        ]);
        await prisma.user.deleteMany({ where: { id: createdUserId } });
      }
      await Promise.allSettled([
        worker?.close(),
        queueEvents?.close(),
        queueEventsConn
          ? queueEventsConn.quit().catch(() => {
              queueEventsConn?.disconnect();
            })
          : Promise.resolve(),
        app.close(),
        queues.close(),
        prisma.$disconnect(),
      ]);
    }
  });
});
