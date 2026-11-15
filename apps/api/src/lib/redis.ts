import { Queue, Worker, type Processor } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";

export interface DisbursementQueueStats {
  connected: boolean;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export interface WorkerHeartbeatInfo {
  alive: boolean;
  lastHeartbeatAt: string | null;
  service: string | null;
  disbursementEnabled: boolean | null;
}

export interface QueueInfrastructure {
  redis: Redis | null;
  disbursementQueue: Queue | null;
  orderExpiryQueue: Queue | null;
  infraHealthQueue: Queue | null;
  prefix: string;
  ping(): Promise<boolean>;
  getDisbursementQueueStats(): Promise<DisbursementQueueStats>;
  recordWorkerHeartbeat(meta: { service: string; disbursementEnabled: boolean }): Promise<void>;
  getWorkerHeartbeat(): Promise<WorkerHeartbeatInfo>;
  close(): Promise<void>;
}

export function buildRedisOptions(redisUrl: string): RedisOptions {
  const isTls = redisUrl.startsWith("rediss://");
  return {
    maxRetriesPerRequest: null, // Required by BullMQ for blocking commands
    enableReadyCheck: false, // Required for Upstash Redis compatibility
    lazyConnect: true,
    ...(isTls ? { tls: {} } : {}),
  };
}

export function createBullMqConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, buildRedisOptions(redisUrl));
}

export function createQueueInfrastructure(redisUrl?: string, prefix = "bigola_mp"): QueueInfrastructure {
  const heartbeatKey = `${prefix}:worker:heartbeat`;

  if (!redisUrl) {
    return {
      redis: null,
      disbursementQueue: null,
      orderExpiryQueue: null,
      infraHealthQueue: null,
      prefix,
      async ping() {
        return false;
      },
      async getDisbursementQueueStats() {
        return { connected: false, waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
      },
      async recordWorkerHeartbeat() {},
      async getWorkerHeartbeat() {
        return { alive: false, lastHeartbeatAt: null, service: null, disbursementEnabled: null };
      },
      async close() {},
    };
  }

  const redis = createBullMqConnection(redisUrl);
  const workerConn = createBullMqConnection(redisUrl);

  const disbursementQueue = new Queue("disbursement-chunks", {
    connection: workerConn,
    prefix,
    defaultJobOptions: {
      removeOnComplete: 500,
      removeOnFail: 1000,
    },
  });

  const orderExpiryQueue = new Queue("order-expiry", {
    connection: workerConn,
    prefix,
    defaultJobOptions: {
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  });

  const infraHealthQueue = new Queue("infra-health", {
    connection: workerConn,
    prefix,
    defaultJobOptions: {
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  });

  return {
    redis,
    disbursementQueue,
    orderExpiryQueue,
    infraHealthQueue,
    prefix,
    async ping() {
      try {
        const res = await redis.ping();
        return res === "PONG";
      } catch {
        return false;
      }
    },
    async getDisbursementQueueStats() {
      try {
        const counts = await disbursementQueue.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "failed",
          "completed"
        );
        return {
          connected: true,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
          completed: counts.completed ?? 0,
        };
      } catch {
        return { connected: false, waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
      }
    },
    async recordWorkerHeartbeat(meta) {
      try {
        const payload = JSON.stringify({
          lastHeartbeatAt: new Date().toISOString(),
          service: meta.service,
          disbursementEnabled: meta.disbursementEnabled,
        });
        await redis.set(heartbeatKey, payload, "EX", 45);
      } catch {
        // Non-fatal heartbeat write failure
      }
    },
    async getWorkerHeartbeat() {
      try {
        const raw = await redis.get(heartbeatKey);
        if (!raw) {
          return { alive: false, lastHeartbeatAt: null, service: null, disbursementEnabled: null };
        }
        const parsed = JSON.parse(raw) as {
          lastHeartbeatAt?: string;
          service?: string;
          disbursementEnabled?: boolean;
        };
        return {
          alive: true,
          lastHeartbeatAt: parsed.lastHeartbeatAt ?? null,
          service: parsed.service ?? null,
          disbursementEnabled:
            typeof parsed.disbursementEnabled === "boolean" ? parsed.disbursementEnabled : null,
        };
      } catch {
        return { alive: false, lastHeartbeatAt: null, service: null, disbursementEnabled: null };
      }
    },
    async close() {
      const closeResults = await Promise.allSettled([
        disbursementQueue.close(),
        orderExpiryQueue.close(),
        infraHealthQueue.close(),
      ]);
      for (const result of closeResults) {
        if (result.status === "rejected") {
          console.error("[redis] Failed to close BullMQ queue:", result.reason);
        }
      }

      const closeClient = async (name: string, client: Redis) => {
        if (client.status === "end") return;
        if (client.status === "wait") {
          client.disconnect();
          return;
        }
        try {
          await client.quit();
        } catch (err) {
          console.error(`[redis] Failed graceful quit for ${name}, forcing disconnect:`, err);
          client.disconnect();
        }
      };

      await Promise.allSettled([
        closeClient("workerConn", workerConn),
        closeClient("redis", redis),
      ]);
    },
  };
}

export function createBullMqWorker(
  queueName: string,
  redisUrl: string,
  prefix: string,
  processor: Processor,
  options?: { concurrency?: number; lockDuration?: number }
): Worker {
  const connection = createBullMqConnection(redisUrl);
  const worker = new Worker(queueName, processor, {
    connection,
    prefix,
    concurrency: options?.concurrency ?? 2,
    ...(options?.lockDuration ? { lockDuration: options.lockDuration } : {}),
  });
  const originalClose = worker.close.bind(worker);
  worker.close = async (force?: boolean) => {
    try {
      await originalClose(force);
    } finally {
      if (connection.status !== "end") {
        await connection.quit().catch(() => {
          connection.disconnect();
        });
      }
    }
  };
  return worker;
}
