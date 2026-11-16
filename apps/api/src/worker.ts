import { loadEnv } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { createBullMqWorker, createQueueInfrastructure } from "./lib/redis.js";
import { DisbursementService } from "./services/disbursement.js";
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

  disbursementWorker.on("failed", (job, err) => {
    console.error(`[disbursement-chunks] job ${job?.id} failed:`, err);
  });

  infraWorker.on("failed", (job, err) => {
    console.error(`[infra-health] job ${job?.id} failed:`, err);
  });

  expiryWorker.on("failed", (job, err) => {
    console.error(`[order-expiry] job ${job?.id} failed:`, err);
  });

  const syncWorkerControlAndHeartbeat = async () => {
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
  };

  await syncWorkerControlAndHeartbeat();

  const heartbeatTimer = setInterval(() => {
    void syncWorkerControlAndHeartbeat();
  }, 15_000);
  heartbeatTimer.unref();

  console.log(
    JSON.stringify({
      event: "worker_started",
      service: "bigola-marketplace-worker",
      queues: ["disbursement-chunks", "infra-health", "order-expiry"],
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
    await Promise.allSettled([
      disbursementWorker.close(),
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
