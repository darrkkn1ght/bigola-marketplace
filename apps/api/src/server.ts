import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import { createPrismaStores } from "./lib/repositories.js";
import { AttributionService } from "./services/attribution.js";
import { CommissionService } from "./services/commission.js";
import { DisbursementService } from "./services/disbursement.js";
import { InventoryService } from "./services/inventory.js";
import { NotificationService } from "./services/notification.js";
import { OrderService } from "./services/order.js";
import { VerificationService } from "./services/verification.js";

async function start() {
  const env = loadEnv();
  const stores = createPrismaStores(prisma);
  const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);
  const attributionService = new AttributionService(prisma, env.SESSION_SECRET);
  const orderService = new OrderService(prisma);
  const inventoryService = new InventoryService(prisma, {
    encryptionKeyHex: env.ENCRYPTION_KEY_HEX,
  });
  const disbursementService = new DisbursementService(prisma, env.ENCRYPTION_KEY_HEX, undefined, {
    disbursementEnabled: env.DISBURSEMENT_ENABLED,
  });
  const commissionService = new CommissionService(prisma);
  const notificationService = new NotificationService(prisma);
  const verificationService = new VerificationService(prisma, commissionService, notificationService);

  const app = await buildApp({
    env,
    authStore: stores.authStore,
    auditStore: stores.auditStore,
    platformStore: stores.platformStore,
    queues,
    prisma,
    attributionService,
    orderService,
    inventoryService,
    disbursementService,
    verificationService,
    notificationService,
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

