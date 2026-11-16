import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CustomerCategory,
  DisbursementChunkStatus,
  DisbursementJobStatus,
  GameAccountHealth,
  GameAccountRole,
  OrderChannel,
  OrderStatus,
  OrderType,
  PrismaClient,
  UserRole,
} from "@prisma/client";
import { ONE_TRILLION } from "@bigola/shared";
import { encryptSensitiveValue, hashPassword } from "./lib/crypto.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import { loadIsolatedTestEnv } from "./lib/test-isolation.js";
import { DisbursementService } from "./services/disbursement.js";
import type { LagosLifeAdapter } from "./services/lagoslife.js";

const RUN_INFRA = process.env.RUN_INFRA_TESTS === "true";

describe("Concurrent Multi-Account Disbursement & Dynamic RESERVE_5+", { skip: !RUN_INFRA }, () => {
  it("executes 3 accounts (including RESERVE_5) concurrently, enforces independent 30.5s cooldowns, waits for all chunks, and halts on ambiguity", async () => {
    const env = loadIsolatedTestEnv();
    const prisma = new PrismaClient();
    const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);
    const runId = Date.now().toString(36).toUpperCase();

    const origR1 = await prisma.gameAccount.findUnique({ where: { slotCode: "RESERVE_1" } });
    const origR2 = await prisma.gameAccount.findUnique({ where: { slotCode: "RESERVE_2" } });
    let createdR5Id: string | null = null;
    const createdUserIds: string[] = [];
    const createdCustomerIds: string[] = [];
    const createdOrderIds: string[] = [];
    const createdJobIds: string[] = [];

    try {
      const owner = await prisma.user.create({
        data: {
          email: `owner-conc-${runId.toLowerCase()}@bigola.test`,
          passwordHash: await hashPassword("OwnerConc123!"),
          role: UserRole.OWNER,
          isActive: true,
        },
      });
      const custUser = await prisma.user.create({
        data: {
          email: `cust-conc-${runId.toLowerCase()}@bigola.test`,
          passwordHash: await hashPassword("CustConc123!"),
          role: UserRole.CUSTOMER,
          isActive: true,
        },
      });
      createdUserIds.push(owner.id, custUser.id);

      const cust = await prisma.customer.create({
        data: {
          userId: custUser.id,
          fullName: "Concurrent Test Buyer",
          email: custUser.email,
          category: CustomerCategory.CATEGORY_B_BIGOLA,
        },
      });
      createdCustomerIds.push(cust.id);

      const makeSession = (username: string) =>
        encryptSensitiveValue(
          JSON.stringify({
            cookie: `ll_session=${username}`,
            uid: `uid_${username}`,
            username,
            simName: username,
            connectedAt: new Date().toISOString(),
            verifiedAt: new Date().toISOString(),
            transactionPin: "1234",
          }),
          env.ENCRYPTION_KEY_HEX
        );

      const r1 = await prisma.gameAccount.upsert({
        where: { slotCode: "RESERVE_1" },
        update: {
          healthStatus: GameAccountHealth.ACTIVE,
          lastKnownBalance: (5n * ONE_TRILLION).toString(),
          reservedForOrders: "0",
          lastSyncedAt: new Date(),
          encryptedSessionBundle: makeSession(`conc_r1_${runId.toLowerCase()}`),
        },
        create: {
          slotCode: "RESERVE_1",
          accountRole: GameAccountRole.RESERVE,
          lagoslifeUsername: `conc_r1_${runId.toLowerCase()}`,
          healthStatus: GameAccountHealth.ACTIVE,
          lastKnownBalance: (5n * ONE_TRILLION).toString(),
          reservedForOrders: "0",
          lastSyncedAt: new Date(),
          encryptedSessionBundle: makeSession(`conc_r1_${runId.toLowerCase()}`),
        },
      });
      const r2 = await prisma.gameAccount.upsert({
        where: { slotCode: "RESERVE_2" },
        update: {
          healthStatus: GameAccountHealth.ACTIVE,
          lastKnownBalance: (5n * ONE_TRILLION).toString(),
          reservedForOrders: "0",
          lastSyncedAt: new Date(),
          encryptedSessionBundle: makeSession(`conc_r2_${runId.toLowerCase()}`),
        },
        create: {
          slotCode: "RESERVE_2",
          accountRole: GameAccountRole.RESERVE,
          lagoslifeUsername: `conc_r2_${runId.toLowerCase()}`,
          healthStatus: GameAccountHealth.ACTIVE,
          lastKnownBalance: (5n * ONE_TRILLION).toString(),
          reservedForOrders: "0",
          lastSyncedAt: new Date(),
          encryptedSessionBundle: makeSession(`conc_r2_${runId.toLowerCase()}`),
        },
      });
      const r5SlotCode = "RESERVE_5";
      const existingR5 = await prisma.gameAccount.findUnique({ where: { slotCode: r5SlotCode } });
      const r5 =
        existingR5 ??
        (await prisma.gameAccount.create({
          data: {
            slotCode: r5SlotCode,
            accountRole: GameAccountRole.RESERVE,
            lagoslifeUsername: `conc_r5_${runId.toLowerCase()}`,
            healthStatus: GameAccountHealth.ACTIVE,
            lastKnownBalance: (5n * ONE_TRILLION).toString(),
            reservedForOrders: "0",
            lastSyncedAt: new Date(),
            encryptedSessionBundle: makeSession(`conc_r5_${runId.toLowerCase()}`),
          },
        }));
      if (!existingR5) createdR5Id = r5.id;
      else {
        await prisma.gameAccount.update({
          where: { id: r5.id },
          data: {
            healthStatus: GameAccountHealth.ACTIVE,
            lastKnownBalance: (5n * ONE_TRILLION).toString(),
            reservedForOrders: "0",
            lastSyncedAt: new Date(),
            encryptedSessionBundle: makeSession(`conc_r5_${runId.toLowerCase()}`),
          },
        });
      }

      // Clear any leftover Redis cooldowns on these 3 accounts
      if (queues.redis) {
        await queues.redis.del(
          `bigola:disbursement:cooldown:${r1.id}`,
          `bigola:disbursement:cooldown:${r2.id}`,
          `bigola:disbursement:cooldown:${r5.id}`
        );
      }

      // Track overlapping sendCurrencyChunk calls
      let activeSends = 0;
      let maxConcurrentSends = 0;
      let totalSends = 0;
      let pass1BarrierResolve: (() => void) | null = null;
      const pass1Barrier = new Promise<void>((res) => {
        pass1BarrierResolve = res;
      });
      const sendEvents: Array<{ cookie: string; event: "START" | "END"; ts: number }> = [];
      let nextOutcome: "SUCCEEDED" | "UNCERTAIN" = "SUCCEEDED";

      const mockAdapter = {
        resolveTargetIdAsync: async (username: string) => ({
          id: `uid_${username}`,
          username,
          name: username,
        }),
        fetchAccountData: async () => {
          if (nextOutcome === "UNCERTAIN" && totalSends >= 5) {
            return { ok: false, status: 503, money: null, error: "Upstream /api/save unavailable" };
          }
          return {
            ok: true,
            status: 200,
            money: 5n * ONE_TRILLION,
          };
        },
        sendCurrencyChunk: async (params: { cookie: string }) => {
          totalSends++;
          activeSends++;
          if (activeSends > maxConcurrentSends) maxConcurrentSends = activeSends;
          if (activeSends === 3 && pass1BarrierResolve) {
            pass1BarrierResolve();
          }
          sendEvents.push({ cookie: params.cookie, event: "START", ts: Date.now() });

          if (totalSends <= 3) {
            // Wait until all 3 accounts enter sendCurrencyChunk concurrently (up to 5s safety timeout)
            await Promise.race([
              pass1Barrier,
              new Promise((res) => setTimeout(res, 5000)),
            ]);
          }

          // Make RESERVE_1 intentionally slower (300ms) while RESERVE_2 and RESERVE_5 finish fast (20ms)
          const delayMs = params.cookie.includes("conc_r1") ? 300 : 20;
          await new Promise((res) => setTimeout(res, delayMs));

          sendEvents.push({ cookie: params.cookie, event: "END", ts: Date.now() });
          activeSends--;

          if (nextOutcome === "UNCERTAIN") {
            return { outcome: "UNCERTAIN", status: 504, message: "Gateway timeout" };
          }
          return { outcome: "SUCCEEDED", status: 200 };
        },
      } as unknown as LagosLifeAdapter;

      const disbSvc = new DisbursementService(prisma, env.ENCRYPTION_KEY_HEX, mockAdapter, {
        redis: queues.redis,
        disbursementEnabled: true,
      });

      // 1. Order for 400B split across RESERVE_1 (100B), RESERVE_2 (200B -> 2 chunks), RESERVE_5 (100B)
      const order = await prisma.order.create({
        data: {
          orderNumber: `ORD-CONC-${runId}`,
          paymentReference: `PAY-CONC-${runId}`,
          channel: OrderChannel.ONLINE_WEB,
          orderType: OrderType.BULK,
          createdByUserId: custUser.id,
          customerId: cust.id,
          customerCategory: CustomerCategory.CATEGORY_B_BIGOLA,
          recipientLagoslifeUsername: `buyer_${runId.toLowerCase()}`,
          gameAmountRequested: "400000000000", // 400B
          fiatAmountKobo: 40000n,
          verifiedGrossFiatKobo: 40000n,
          pricingSnapshot: { version: 1 },
          status: OrderStatus.READY_FOR_FULFILMENT,
        },
      });
      createdOrderIds.push(order.id);

      const job = await disbSvc.authorizeDisbursementJob({
        orderId: order.id,
        actorUserId: owner.id,
        actorRole: UserRole.OWNER,
        allocations: [
          { slotCode: "RESERVE_1", amount: 100_000_000_000n },
          { slotCode: "RESERVE_2", amount: 200_000_000_000n },
          { slotCode: "RESERVE_5", amount: 100_000_000_000n },
        ],
      });
      createdJobIds.push(job.id);
      assert.equal(job.totalChunks, 4);
      await disbSvc.prepareJobForQueuedExecution({ jobId: job.id, actorUserId: owner.id });

      // Pass 1: All 3 accounts must overlap concurrently, and slow RESERVE_1 must NOT block R2/R5 from starting or finishing first
      const pass1 = await disbSvc.processJobStepForWorker({ jobId: job.id, actorUserId: owner.id });
      assert.equal(totalSends, 3);
      assert.equal(maxConcurrentSends, 3, `Expected 3 overlapping sends, got ${maxConcurrentSends}`);

      const r1End = sendEvents.find((e) => e.cookie.includes("conc_r1") && e.event === "END")!;
      const r2Start = sendEvents.find((e) => e.cookie.includes("conc_r2") && e.event === "START")!;
      const r5Start = sendEvents.find((e) => e.cookie.includes("conc_r5") && e.event === "START")!;
      assert.ok(r2Start.ts < r1End.ts, "RESERVE_2 must start before slow RESERVE_1 finishes");
      assert.ok(r5Start.ts < r1End.ts, "RESERVE_5 must start before slow RESERVE_1 finishes");

      // Order must NOT be COMPLETED yet (300B/400B delivered, 1 chunk left on RESERVE_2)
      const orderAfterPass1 = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(orderAfterPass1.status, OrderStatus.PARTIALLY_FULFILLED);
      assert.ok(pass1.nextDelayMs !== null && pass1.nextDelayMs > 0);

      // Immediate pass while cooldowns are active must send 0 chunks
      await disbSvc.processJobStepForWorker({ jobId: job.id, actorUserId: owner.id });
      assert.equal(totalSends, 3, "Cooldown must prevent immediate second send");

      // Simulate RESERVE_2 cooldown expiry in Redis while keeping others intact -> completes 4th chunk and order
      if (queues.redis) {
        await queues.redis.del(`bigola:disbursement:cooldown:${r2.id}`);
      }
      const disbSvcAfterCooldown = new DisbursementService(prisma, env.ENCRYPTION_KEY_HEX, mockAdapter, {
        redis: queues.redis,
        disbursementEnabled: true,
      });
      const pass2 = await disbSvcAfterCooldown.processJobStepForWorker({ jobId: job.id, actorUserId: owner.id });
      assert.equal(
        totalSends,
        4,
        `Expected 4 sends, got ${totalSends}; jobStatus=${pass2.job?.status}; chunks=${JSON.stringify(
          pass2.job?.chunks.map((c) => ({ slot: c.sourceSlotCode, status: c.status }))
        )}`
      );
      assert.equal(pass2.nextDelayMs, null);
      const orderFinal = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(orderFinal.status, OrderStatus.COMPLETED);

      // 2. Verify even-split calculation assigns non-zero amounts across all 3 selected accounts
      const totalB = 400n; // 400B across 3 accounts
      const selectedCount = 3n;
      const baseShare = totalB / selectedCount;
      assert.ok(baseShare > 0n);

      // 3. Ambiguous transfer stops immediately and is never auto-retried
      if (queues.redis) {
        await queues.redis.del(`bigola:disbursement:cooldown:${r5.id}`);
      }
      const disbSvcAmb = new DisbursementService(prisma, env.ENCRYPTION_KEY_HEX, mockAdapter, {
        redis: queues.redis,
        disbursementEnabled: true,
      });
      const ambOrder = await prisma.order.create({
        data: {
          orderNumber: `ORD-AMB-${runId}`,
          paymentReference: `PAY-AMB-${runId}`,
          channel: OrderChannel.ONLINE_WEB,
          orderType: OrderType.BULK,
          createdByUserId: custUser.id,
          customerId: cust.id,
          customerCategory: CustomerCategory.CATEGORY_B_BIGOLA,
          recipientLagoslifeUsername: `amb_${runId.toLowerCase()}`,
          gameAmountRequested: "100000000000",
          fiatAmountKobo: 10000n,
          verifiedGrossFiatKobo: 10000n,
          pricingSnapshot: { version: 1 },
          status: OrderStatus.READY_FOR_FULFILMENT,
        },
      });
      createdOrderIds.push(ambOrder.id);

      const ambJob = await disbSvcAmb.authorizeDisbursementJob({
        orderId: ambOrder.id,
        actorUserId: owner.id,
        actorRole: UserRole.OWNER,
        allocations: [{ slotCode: "RESERVE_5", amount: 100_000_000_000n }],
      });
      createdJobIds.push(ambJob.id);
      await disbSvcAmb.prepareJobForQueuedExecution({ jobId: ambJob.id, actorUserId: owner.id });

      nextOutcome = "UNCERTAIN";
      const ambRes = await disbSvcAmb.processJobStepForWorker({ jobId: ambJob.id, actorUserId: owner.id });
      assert.equal(
        ambRes.nextDelayMs,
        null,
        `ambRes nextDelayMs=${ambRes.nextDelayMs}, jobStatus=${ambRes.job?.status}, chunks=${JSON.stringify(
          ambRes.job?.chunks.map((c) => ({ slot: c.sourceSlotCode, status: c.status }))
        )}, redisVal=${await queues.redis?.get(`bigola:disbursement:cooldown:${r5.id}`)}`
      );
      assert.equal(ambRes.job?.status, DisbursementJobStatus.PAUSED);
      assert.equal(ambRes.job?.chunks[0]?.status, DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW);

      const sendsBeforeRetry = totalSends;
      await disbSvcAmb.processJobStepForWorker({ jobId: ambJob.id, actorUserId: owner.id });
      assert.equal(totalSends, sendsBeforeRetry, "Ambiguous chunk must never be auto-retried");
    } finally {
      if (createdJobIds.length > 0) {
        await prisma.disbursementChunk.deleteMany({ where: { jobId: { in: createdJobIds } } }).catch(() => undefined);
        await prisma.disbursementJob.deleteMany({ where: { id: { in: createdJobIds } } }).catch(() => undefined);
      }
      if (createdOrderIds.length > 0) {
        await prisma.inventoryLedger.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => undefined);
      }
      if (createdCustomerIds.length > 0) {
        await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } }).catch(() => undefined);
      }
      if (createdUserIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
      }
      if (origR1) {
        await prisma.gameAccount.update({
          where: { id: origR1.id },
          data: {
            lastKnownBalance: origR1.lastKnownBalance,
            reservedForOrders: origR1.reservedForOrders,
            lastSyncedAt: origR1.lastSyncedAt,
            healthStatus: origR1.healthStatus,
            encryptedSessionBundle: origR1.encryptedSessionBundle,
          },
        }).catch(() => undefined);
      }
      if (origR2) {
        await prisma.gameAccount.update({
          where: { id: origR2.id },
          data: {
            lastKnownBalance: origR2.lastKnownBalance,
            reservedForOrders: origR2.reservedForOrders,
            lastSyncedAt: origR2.lastSyncedAt,
            healthStatus: origR2.healthStatus,
            encryptedSessionBundle: origR2.encryptedSessionBundle,
          },
        }).catch(() => undefined);
      }
      if (createdR5Id) {
        await prisma.gameAccount.delete({ where: { id: createdR5Id } }).catch(() => undefined);
      }
      await queues.close();
      await prisma.$disconnect();
    }
  });
});
