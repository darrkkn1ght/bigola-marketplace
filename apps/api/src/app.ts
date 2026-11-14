import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { AppEnv } from "./config/env.js";
import { AuditLogger, type AuditLogStore } from "./lib/audit.js";
import type { QueueInfrastructure } from "./lib/redis.js";
import type { AuthStore, PlatformStore } from "./lib/repositories.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCustomerRoutes } from "./routes/customer.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerOwnerRoutes } from "./routes/owner.js";
import { registerPartnerRoutes } from "./routes/partner.js";

export interface AppDependencies {
  env: AppEnv;
  authStore: AuthStore;
  auditStore: AuditLogStore;
  platformStore: PlatformStore;
  queues: QueueInfrastructure;
  checkDb: () => Promise<boolean>;
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
    origin: deps.env.WEB_BASE_URL,
    credentials: true,
  });

  const audit = new AuditLogger(deps.auditStore);
  const { authenticate, requirePermission } = createAuthMiddleware({
    authStore: deps.authStore,
    sessionSecret: deps.env.SESSION_SECRET,
    ownerRequire2fa: deps.env.OWNER_REQUIRE_2FA,
    webBaseUrl: deps.env.WEB_BASE_URL,
  });

  registerHealthRoutes(app, { queues: deps.queues, checkDb: deps.checkDb });
  registerAuthRoutes(app, {
    authStore: deps.authStore,
    audit,
    authenticate,
    sessionSecret: deps.env.SESSION_SECRET,
    encryptionKeyHex: deps.env.ENCRYPTION_KEY_HEX,
    sessionTtlHours: deps.env.SESSION_TTL_HOURS,
    isProd: deps.env.NODE_ENV === "production",
  });
  registerCustomerRoutes(app, { authenticate, requirePermission });
  registerPartnerRoutes(app, {
    authenticate,
    requirePermission,
    platformStore: deps.platformStore,
  });
  registerOwnerRoutes(app, {
    authenticate,
    requirePermission,
    platformStore: deps.platformStore,
    audit,
  });

  return app;
}

