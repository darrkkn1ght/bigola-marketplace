import { loadEnv } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { createBullMqWorker, createQueueInfrastructure } from "./lib/redis.js";
import { DisbursementService } from "./services/disbursement.js";
import { InventoryService } from "./services/inventory.js";
import { LagosLifeAdapter } from "./services/lagoslife.js";
import { OrderService } from "./services/order.js";

export interface DisbursementWorkerJobPayload {
  jobId: string;
  actorUserId?: string;
  pinByAccountId?: Record<string, string>;
}

async function startWorker() {
  const env = loadEnv();

  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL is required to start the background worker service.");
  }

  await prisma.$queryRaw`SELECT 1`;
  const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);
  const redisOk = await queues.ping();
  if (!redisOk) {
    throw new Error("Redis PING failed during worker startup.");
  }

  const adapter = new LagosLifeAdapter();
  const disbursementService = new DisbursementService(
    prisma,
    env.ENCRYPTION_KEY_HEX,
    adapter,
    {
      redis: queues.redis,
      disbursementEnabled: env.DISBURSEMENT_ENABLED,
    }
  );
  const orderService = new OrderService(prisma);
  const inventoryService = new InventoryService(prisma, {
    encryptionKeyHex: env.ENCRYPTION_KEY_HEX,
    lagosLifeAdapter: adapter,
  });

  // Startup crash recovery:
  // 1. Move any stale IN_FLIGHT chunks to AMBIGUOUS_MANUAL_REVIEW (never blindly retry).
  // 2. Re-enqueue healthy RUNNING jobs if DISBURSEMENT_ENABLED=true.
  const recovery = await disbursementService.recoverStaleInFlightChunksAndJobs();
  if (recovery.pausedAmbiguousJobIds.length > 0) {
    console.warn(
      JSON.stringify({
        event: "worker_startup_stale_inflight_paused",
        pausedAmbiguousJobIds: recovery.pausedAmbiguousJobIds,
      })
    );
  }

  if (env.DISBURSEMENT_ENABLED && queues.disbursementQueue) {
    for (const jobId of recovery.resumableRunningJobIds) {
      const existing = await queues.disbursementQueue.getJob(`disb_exec_${jobId}`);
      if (existing) {
        const state = await existing.getState().catch(() => "unknown");
        if (state === "completed" || state === "failed") {
          await existing.remove().catch(() => undefined);
        }
      }
      await queues.disbursementQueue.add(
        "process-disbursement-job",
        { jobId } satisfies DisbursementWorkerJobPayload,
        {
          jobId: `disb_exec_${jobId}`,
          attempts: 1, // Critical: never auto-retry uncertain transfers at BullMQ layer
        }
      );
    }
  }

  const initialControl = await queues.getWorkerControl();

  const disbursementWorker = createBullMqWorker(
    "disbursement-chunks",
    env.REDIS_URL,
    env.QUEUE_PREFIX,
    async (bullJob) => {
      const payload = (bullJob.data ?? {}) as DisbursementWorkerJobPayload;
      if (!payload.jobId) {
        return { skipped: true, reason: "MISSING_JOB_ID" };
      }

      if (!env.DISBURSEMENT_ENABLED) {
        return { skipped: true, reason: "DISBURSEMENT_DISABLED" };
      }

      const control = await queues.getWorkerControl();
      if (control.intakePaused) {
        if (!disbursementWorker.isPaused()) {
          await disbursementWorker.pause();
        }
        if (queues.disbursementQueue) {
          await queues.disbursementQueue.add(
            "process-disbursement-job",
            payload,
            {
              jobId: `disb_exec_${payload.jobId}_paused_${Date.now()}`,
              delay: 15_000,
              attempts: 1,
            }
          );
        }
        return { skipped: true, reason: "WORKER_INTAKE_PAUSED_REQUEUED" };
      }

      const { job, nextDelayMs } = await disbursementService.processJobStepForWorker({
        jobId: payload.jobId,
        actorUserId: payload.actorUserId,
        pinByAccountId: payload.pinByAccountId,
      });

      // If more runnable chunks remain on cooldown or account lock, schedule next pass via BullMQ delay
      if (nextDelayMs !== null && queues.disbursementQueue) {
        const stepJobId = `disb_exec_${payload.jobId}_step_${Date.now()}`;
        await queues.disbursementQueue.add(
          "process-disbursement-job",
          payload,
          {
            jobId: stepJobId,
            delay: nextDelayMs,
            attempts: 1,
          }
        );
      } else if (
        nextDelayMs === null &&
        job?.status === "COMPLETED" &&
        queues.disbursementQueue &&
        queues.redis
      ) {
        const autoQueueKey = `${env.QUEUE_PREFIX}:disbursement:auto_queue`;
        while (true) {
          const nextJobId = await queues.redis.lpop(autoQueueKey);
          if (!nextJobId) break;
          try {
            const prep = await disbursementService.prepareJobForQueuedExecution({
              jobId: nextJobId,
              actorUserId: payload.actorUserId,
            });
            if (!prep.alreadyCompleted) {
              const autoStepId = `disb_exec_${nextJobId}_auto_${Date.now()}`;
              await queues.disbursementQueue.add(
                "process-disbursement-job",
                {
                  jobId: nextJobId,
                  orderId: prep.job.orderId,
                  actorUserId: payload.actorUserId,
                },
                {
                  jobId: autoStepId,
                  delay: 30_500,
                  attempts: 1,
                }
              );
              console.log(
                `[worker] Auto-queued next disbursement job ${nextJobId} (order ${prep.job.orderId}) in 30.5s`
              );
              break;
            }
          } catch (err) {
            console.warn(
              `[worker] Skipping auto-queue job ${nextJobId}:`,
              err instanceof Error ? err.message : String(err)
            );
          }
        }
      }

      return {
        jobId: payload.jobId,
        status: job?.status ?? null,
        completedChunks: job?.completedChunks ?? 0,
        totalChunks: job?.totalChunks ?? 0,
        nextDelayMs,
      };
    },
    {
      concurrency: initialControl.permittedConcurrency, // Bounded 1..5, controlled via Owner Dashboard
      lockDuration: 90_000,
    }
  );

  if (initialControl.intakePaused) {
    await disbursementWorker.pause();
  }

  const infraWorker = createBullMqWorker(
    "infra-health",
    env.REDIS_URL,
    env.QUEUE_PREFIX,
    async (job) => {
      await queues.recordWorkerHeartbeat({
        service: "bigola-marketplace-worker",
        disbursementEnabled: env.DISBURSEMENT_ENABLED,
      });
      return {
        ok: true,
        jobId: job.id,
        processedAt: new Date().toISOString(),
        disbursementEnabled: env.DISBURSEMENT_ENABLED,
      };
    }
  );

  const expiryWorker = createBullMqWorker(
    "order-expiry",
    env.REDIS_URL,
    env.QUEUE_PREFIX,
    async (job) => {
      const result = await orderService.expireStaleOrders();
      return {
        acknowledged: true,
        jobName: job.name,
        expiredCount: result.expiredCount,
      };
    }
  );

  const inventorySyncWorker = createBullMqWorker(
    "inventory-sync",
    env.REDIS_URL,
    env.QUEUE_PREFIX,
    async (job) => {
      if (job.name === "treasury-refill") {
        const data = (job.data ?? {}) as {
          actorUserId: string;
          targetSlotCode: string;
          remainingAmount: string;
          refillId: string;
          stepIndex: number;
          reason: string;
          ipAddress?: string;
        };
        const step = await inventoryService.executeTreasuryToReserveStep({
          actorUserId: data.actorUserId,
          targetSlotCode: data.targetSlotCode,
          remainingAmount: BigInt(data.remainingAmount || "0"),
          refillId: data.refillId,
          stepIndex: data.stepIndex,
          reason: data.reason,
          ipAddress: data.ipAddress,
          disbursementEnabled: env.DISBURSEMENT_ENABLED,
        });
        if (
          step.nextDelayMs !== null &&
          BigInt(step.remainingAmount) > 0n &&
          queues.inventorySyncQueue
        ) {
          const nextStep = data.stepIndex + 1;
          await queues.inventorySyncQueue.add(
            "treasury-refill",
            {
              ...data,
              remainingAmount: step.remainingAmount,
              stepIndex: nextStep,
            },
            {
              jobId: `treasury_refill_${data.refillId}_${nextStep}`,
              delay: step.nextDelayMs,
              attempts: 1,
            }
          );
        }
        return step;
      }

      const lockKey = `${env.QUEUE_PREFIX}:inventory_sync:lock`;
      const acquired = queues.redis
        ? await queues.redis.set(lockKey, job.id ?? "1", "PX", 120_000, "NX")
        : "OK";
      if (!acquired) {
        return { skipped: true, reason: "SYNC_LOCK_HELD" };
      }
      try {
        const owner = await prisma.user.findFirst({
          where: { role: "OWNER", isActive: true },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
        if (!owner) {
          return { skipped: true, reason: "NO_ACTIVE_OWNER" };
        }
        const syncResult = await inventoryService.syncAllLiveBalances({
          actorUserId: owner.id,
          skipInFlight: true,
        });
        return {
          ok: true,
          syncedAt: new Date().toISOString(),
          results: syncResult.results.map((r) => ({
            slotCode: r.slotCode,
            status: r.status,
          })),
        };
      } finally {
        if (queues.redis) {
          await queues.redis.del(lockKey).catch(() => undefined);
        }
      }
    },
    { concurrency: 1, lockDuration: 120_000 }
  );

  disbursementWorker.on("failed", (job, err) => {
    console.error(`[disbursement-chunks] job ${job?.id} failed:`, err);
  });

  infraWorker.on("failed", (job, err) => {
    console.error(`[infra-health] job ${job?.id} failed:`, err);
  });

  expiryWorker.on("failed", (job, err) => {
    console.error(`[order-expiry] job ${job?.id} failed:`, err);
  });

  inventorySyncWorker.on("failed", (job, err) => {
    console.error(`[inventory-sync] job ${job?.id} failed:`, err);
  });

  const syncWorkerControlAndHeartbeat = async () => {
    try {
      const control = await queues.getWorkerControl();
      if (control.intakePaused && !disbursementWorker.isPaused()) {
        await disbursementWorker.pause();
      } else if (!control.intakePaused && disbursementWorker.isPaused()) {
        disbursementWorker.resume();
      }
      if (disbursementWorker.concurrency !== control.permittedConcurrency) {
        disbursementWorker.concurrency = control.permittedConcurrency;
      }
      await queues.recordWorkerHeartbeat({
        service: "bigola-marketplace-worker",
        disbursementEnabled: env.DISBURSEMENT_ENABLED,
        intakePaused: control.intakePaused,
        permittedConcurrency: control.permittedConcurrency,
      });
    } catch (err) {
      console.error("[worker] heartbeat/control sync failed:", (err as Error).message);
    }
  };

  await syncWorkerControlAndHeartbeat();

  const heartbeatTimer = setInterval(() => {
    void syncWorkerControlAndHeartbeat();
  }, 15_000);
  heartbeatTimer.unref();

  let inventorySyncTimer: ReturnType<typeof setInterval> | null = null;
  if (queues.inventorySyncQueue) {
    const syncQueue = queues.inventorySyncQueue;
    const syncIntervalMinutes = Math.max(
      5,
      Math.min(60, Number(process.env.INVENTORY_SYNC_INTERVAL_MINUTES ?? 15) || 15)
    );
    const enqueueInventorySync = async (label: string, delayMs = 0) => {
      try {
        await syncQueue.add(
          label,
          {},
          {
            jobId: `${label}-${Date.now()}`,
            ...(delayMs > 0 ? { delay: delayMs } : {}),
            attempts: 1,
          }
        );
      } catch (err) {
        console.error(`[inventory-sync] Failed to enqueue ${label}:`, err);
      }
    };
    void enqueueInventorySync("startup-inventory-sync", 10_000);
    inventorySyncTimer = setInterval(() => {
      void enqueueInventorySync("periodic-inventory-sync");
    }, syncIntervalMinutes * 60_000);
    inventorySyncTimer.unref();
  }

  console.log(
    JSON.stringify({
      event: "worker_started",
      service: "bigola-marketplace-worker",
      queues: ["disbursement-chunks", "infra-health", "order-expiry", "inventory-sync"],
      concurrency: 5,
      disbursementEnabled: env.DISBURSEMENT_ENABLED,
      recoveredRunningJobs: recovery.resumableRunningJobIds.length,
      pausedAmbiguousJobs: recovery.pausedAmbiguousJobIds.length,
    })
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    if (inventorySyncTimer) clearInterval(inventorySyncTimer);
    await Promise.allSettled([
      disbursementWorker.close(),
      infraWorker.close(),
      expiryWorker.close(),
      inventorySyncWorker.close(),
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
