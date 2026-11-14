import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import { createPrismaStores } from "./lib/repositories.js";

async function start() {
  const env = loadEnv();
  const stores = createPrismaStores(prisma);
  const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);

  const app = await buildApp({
    env,
    authStore: stores.authStore,
    auditStore: stores.auditStore,
    platformStore: stores.platformStore,
    queues,
    async checkDb() {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
  });

  const shutdown = async () => {
    await app.close();
    await queues.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
}

start().catch((err) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});

