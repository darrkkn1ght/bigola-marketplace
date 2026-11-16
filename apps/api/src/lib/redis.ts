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
  intakePaused?: boolean | null;
  permittedConcurrency?: number | null;
}

export interface WorkerControlState {
  intakePaused: boolean;
  permittedConcurrency: number;
  updatedAt: string | null;
  updatedBy: string | null;
  reason: string | null;
}

export interface QueueInfrastructure {
  redis: Redis | null;
  disbursementQueue: Queue | null;
  orderExpiryQueue: Queue | null;
  infraHealthQueue: Queue | null;
  inventorySyncQueue: Queue | null;
  prefix: string;
  ping(): Promise<boolean>;
  getDisbursementQueueStats(): Promise<DisbursementQueueStats>;
  recordWorkerHeartbeat(meta: {
    service: string;
    disbursementEnabled: boolean;
    intakePaused?: boolean;
    permittedConcurrency?: number;
  }): Promise<void>;
  getWorkerHeartbeat(): Promise<WorkerHeartbeatInfo>;
  getWorkerControl(): Promise<WorkerControlState>;
  setWorkerControl(next: Partial<WorkerControlState>): Promise<WorkerControlState>;
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
  const controlKey = `${prefix}:worker:control`;
  const defaultControl: WorkerControlState = {
    intakePaused: false,
    permittedConcurrency: 5,
    updatedAt: null,
    updatedBy: null,
    reason: null,
  };

  if (!redisUrl) {
    return {
      redis: null,
      disbursementQueue: null,
      orderExpiryQueue: null,
      infraHealthQueue: null,
      inventorySyncQueue: null,
      prefix,
      async ping() {
        return false;
      },
      async getDisbursementQueueStats() {
        return { connected: false, waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
      },
      async recordWorkerHeartbeat() {},
      async getWorkerHeartbeat() {
        return {
          alive: false,
          lastHeartbeatAt: null,
          service: null,
          disbursementEnabled: null,
          intakePaused: null,
          permittedConcurrency: null,
        };
      },
      async getWorkerControl() {
        return { ...defaultControl };
      },
      async setWorkerControl(next) {
        return {
          ...defaultControl,
          ...next,
          permittedConcurrency: Math.min(5, Math.max(1, Math.floor(next.permittedConcurrency ?? 5))),
          updatedAt: new Date().toISOString(),
        };
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

  const inventorySyncQueue = new Queue("inventory-sync", {
    connection: workerConn,
    prefix,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });

  return {
    redis,
    disbursementQueue,
    orderExpiryQueue,
    infraHealthQueue,
    inventorySyncQueue,
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
          intakePaused: typeof meta.intakePaused === "boolean" ? meta.intakePaused : null,
          permittedConcurrency:
            typeof meta.permittedConcurrency === "number" ? meta.permittedConcurrency : null,
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
          return {
            alive: false,
            lastHeartbeatAt: null,
            service: null,
            disbursementEnabled: null,
            intakePaused: null,
            permittedConcurrency: null,
          };
        }
        const parsed = JSON.parse(raw) as {
          lastHeartbeatAt?: string;
          service?: string;
          disbursementEnabled?: boolean;
          intakePaused?: boolean | null;
          permittedConcurrency?: number | null;
        };
        return {
          alive: true,
          lastHeartbeatAt: parsed.lastHeartbeatAt ?? null,
          service: parsed.service ?? null,
          disbursementEnabled:
            typeof parsed.disbursementEnabled === "boolean" ? parsed.disbursementEnabled : null,
          intakePaused: typeof parsed.intakePaused === "boolean" ? parsed.intakePaused : null,
          permittedConcurrency:
            typeof parsed.permittedConcurrency === "number" ? parsed.permittedConcurrency : null,
        };
      } catch {
        return {
          alive: false,
          lastHeartbeatAt: null,
          service: null,
          disbursementEnabled: null,
          intakePaused: null,
          permittedConcurrency: null,
        };
      }
    },
    async getWorkerControl() {
      try {
        const raw = await redis.get(controlKey);
        if (!raw) return { ...defaultControl };
        const parsed = JSON.parse(raw) as Partial<WorkerControlState>;
        const rawConc = Number(parsed.permittedConcurrency ?? 5);
        return {
          intakePaused: parsed.intakePaused === true,
          permittedConcurrency: Number.isFinite(rawConc)
            ? Math.min(5, Math.max(1, Math.floor(rawConc)))
            : 5,
          updatedAt: parsed.updatedAt ?? null,
          updatedBy: parsed.updatedBy ?? null,
          reason: parsed.reason ?? null,
        };
      } catch {
        return { ...defaultControl };
      }
    },
    async setWorkerControl(next) {
      const current = await this.getWorkerControl();
      const rawConc = Number(next.permittedConcurrency ?? current.permittedConcurrency);
      const merged: WorkerControlState = {
        intakePaused:
          typeof next.intakePaused === "boolean" ? next.intakePaused : current.intakePaused,
        permittedConcurrency: Number.isFinite(rawConc)
          ? Math.min(5, Math.max(1, Math.floor(rawConc)))
          : current.permittedConcurrency,
        updatedAt: new Date().toISOString(),
        updatedBy: next.updatedBy !== undefined ? next.updatedBy : current.updatedBy,
        reason: next.reason !== undefined ? next.reason : current.reason,
      };
      await redis.set(controlKey, JSON.stringify(merged));
      return merged;
    },
    async close() {
      const closeResults = await Promise.allSettled([
        disbursementQueue.close(),
        orderExpiryQueue.close(),
        infraHealthQueue.close(),
        inventorySyncQueue.close(),
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
