import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { PrismaClient } from "@prisma/client";
import type { AppEnv } from "./config/env.js";
import { AuditLogger, type AuditLogStore } from "./lib/audit.js";
import type { QueueInfrastructure } from "./lib/redis.js";
import type { AuthStore, PlatformStore } from "./lib/repositories.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCustomerRoutes } from "./routes/customer.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerOwnerRoutes } from "./routes/owner.js";
import { registerPartnerRoutes } from "./routes/partner.js";
import { registerReferralRoutes } from "./routes/referrals.js";
import { registerVerificationRoutes } from "./routes/verification.js";
import type { AnalyticsService } from "./services/analytics.js";
import type { AttributionService } from "./services/attribution.js";
import type { DisbursementService } from "./services/disbursement.js";
import type { InventoryService } from "./services/inventory.js";
import type { NotificationService } from "./services/notification.js";
import type { OperationsService } from "./services/operations.js";
import type { OrderService } from "./services/order.js";
import type { SupportService } from "./services/support.js";
import type { VerificationService } from "./services/verification.js";

export interface AppDependencies {
  env: AppEnv;
  authStore: AuthStore;
  auditStore: AuditLogStore;
  platformStore: PlatformStore;
  queues: QueueInfrastructure;
  checkDb: () => Promise<boolean>;
  prisma?: PrismaClient;
  attributionService?: AttributionService;
  orderService?: OrderService;
  inventoryService?: InventoryService;
  disbursementService?: DisbursementService;
  verificationService?: VerificationService;
  notificationService?: NotificationService;
  operationsService?: OperationsService;
  supportService?: SupportService;
  analyticsService?: AnalyticsService;
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.env.NODE_ENV !== "test",
    trustProxy: true,
  });

  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
  });
  await app.register(cors, {
    origin: deps.env.allowedOrigins,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "Idempotency-Key"],
  });

  const audit = new AuditLogger(deps.auditStore);
  const { authenticate, requirePermission } = createAuthMiddleware({
    authStore: deps.authStore,
    sessionSecret: deps.env.SESSION_SECRET,
    ownerRequire2fa: deps.env.OWNER_REQUIRE_2FA,
    allowedOrigins: deps.env.allowedOrigins,
  });

  registerHealthRoutes(app, {
    queues: deps.queues,
    checkDb: deps.checkDb,
    disbursementEnabled: deps.env.DISBURSEMENT_ENABLED,
  });
  registerReferralRoutes(app, {
    attributionService: deps.attributionService,
    sessionSecret: deps.env.SESSION_SECRET,
    isProd: deps.env.NODE_ENV === "production",
  });
  registerAuthRoutes(app, {
    authStore: deps.authStore,
    attributionService: deps.attributionService,
    prisma: deps.prisma,
    audit,
    authenticate,
    sessionSecret: deps.env.SESSION_SECRET,
    encryptionKeyHex: deps.env.ENCRYPTION_KEY_HEX,
    sessionTtlHours: deps.env.SESSION_TTL_HOURS,
    isProd: deps.env.NODE_ENV === "production",
  });
  registerCustomerRoutes(app, {
    authenticate,
    requirePermission,
    prisma: deps.prisma,
    orderService: deps.orderService,
    verificationService: deps.verificationService,
  });
  registerPartnerRoutes(app, {
    authenticate,
    requirePermission,
    platformStore: deps.platformStore,
    attributionService: deps.attributionService,
    orderService: deps.orderService,
    verificationService: deps.verificationService,
    prisma: deps.prisma,
    webBaseUrl: deps.env.WEB_BASE_URL,
  });
  registerOwnerRoutes(app, {
    authenticate,
    requirePermission,
    platformStore: deps.platformStore,
    audit,
    attributionService: deps.attributionService,
    orderService: deps.orderService,
    inventoryService: deps.inventoryService,
    disbursementService: deps.disbursementService,
    verificationService: deps.verificationService,
    operationsService: deps.operationsService,
    analyticsService: deps.analyticsService,
    disbursementEnabled: deps.env.DISBURSEMENT_ENABLED,
    encryptionKeyHex: deps.env.ENCRYPTION_KEY_HEX,
    prisma: deps.prisma,
    queues: deps.queues,
  });
  registerOpsRoutes(app, {
    authenticate,
    requirePermission,
    prisma: deps.prisma,
    operationsService: deps.operationsService,
    inventoryService: deps.inventoryService,
    supportService: deps.supportService,
    disbursementEnabled: deps.env.DISBURSEMENT_ENABLED,
    encryptionKeyHex: deps.env.ENCRYPTION_KEY_HEX,
  });
  registerVerificationRoutes(app, {
    authenticate,
    requirePermission,
    prisma: deps.prisma,
    verificationService: deps.verificationService,
  });
  registerNotificationRoutes(app, {
    authenticate,
    prisma: deps.prisma,
    notificationService: deps.notificationService,
  });

  return app;
}
