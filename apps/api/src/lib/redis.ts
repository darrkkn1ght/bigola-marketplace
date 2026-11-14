import { Queue, Worker, type Processor } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";

export interface QueueInfrastructure {
  redis: Redis | null;
  disbursementQueue: Queue | null;
  orderExpiryQueue: Queue | null;
  infraHealthQueue: Queue | null;
  ping(): Promise<boolean>;
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
  if (!redisUrl) {
    return {
      redis: null,
      disbursementQueue: null,
      orderExpiryQueue: null,
      infraHealthQueue: null,
      async ping() {
        return false;
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
    async ping() {
      try {
        const res = await redis.ping();
        return res === "PONG";
      } catch {
        return false;
      }
    },
    async close() {
      await Promise.allSettled([
        disbursementQueue.close(),
        orderExpiryQueue.close(),
        infraHealthQueue.close(),
        workerConn.quit(),
        redis.quit(),
      ]);
    },
  };
}

export function createBullMqWorker(
  queueName: string,
  redisUrl: string,
  prefix: string,
  processor: Processor
): Worker {
  const connection = createBullMqConnection(redisUrl);
  return new Worker(queueName, processor, {
    connection,
    prefix,
    concurrency: 2,
  });
}
