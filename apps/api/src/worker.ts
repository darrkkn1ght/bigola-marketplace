import { loadEnv } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { createBullMqWorker, createQueueInfrastructure } from "./lib/redis.js";

async function startWorker() {
  const env = loadEnv();

  if (env.DISBURSEMENT_ENABLED) {
    throw new Error(
      "Safety lock: DISBURSEMENT_ENABLED must remain false in Phase 2. Automated LagosLife transfers are not enabled."
    );
  }

  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL is required to start the Railway background worker service.");
  }

  await prisma.$queryRaw`SELECT 1`;
  const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);
  const redisOk = await queues.ping();
  if (!redisOk) {
    throw new Error("Upstash Redis PING failed during worker startup.");
  }

  const infraWorker = createBullMqWorker(
    "infra-health",
    env.REDIS_URL,
    env.QUEUE_PREFIX,
    async (job) => {
      return {
        ok: true,
        jobId: job.id,
        processedAt: new Date().toISOString(),
        disbursementEnabled: false,
      };
    }
  );

  const expiryWorker = createBullMqWorker(
    "order-expiry",
    env.REDIS_URL,
    env.QUEUE_PREFIX,
    async (job) => {
      return {
        acknowledged: true,
        jobName: job.name,
        phase: "PHASE_2_FOUNDATION",
      };
    }
  );

  infraWorker.on("failed", (job, err) => {
    console.error(`[infra-health] job ${job?.id} failed:`, err);
  });

  expiryWorker.on("failed", (job, err) => {
    console.error(`[order-expiry] job ${job?.id} failed:`, err);
  });

  console.log(
    JSON.stringify({
      event: "worker_started",
      service: "bigola-marketplace-worker",
      queues: ["infra-health", "order-expiry"],
      disbursementEnabled: false,
    })
  );

  const shutdown = async () => {
    await Promise.allSettled([
      infraWorker.close(),
      expiryWorker.close(),
      queues.close(),
      prisma.$disconnect(),
    ]);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startWorker().catch((err) => {
  console.error("Failed to start background worker:", err);
  process.exit(1);
});

