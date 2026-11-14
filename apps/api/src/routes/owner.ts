import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permission, PRIMARY_SUPPLIER_USERNAME } from "@bigola/shared";
import type { AuditLogger } from "../lib/audit.js";
import type { PlatformStore } from "../lib/repositories.js";

const updateSettingSchema = z.object({
  value: z.record(z.unknown()),
  reason: z.string().min(3).max(500),
});

export function registerOwnerRoutes(
  app: FastifyInstance,
  deps: {
    authenticate: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["authenticate"];
    requirePermission: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["requirePermission"];
    platformStore: PlatformStore;
    audit: AuditLogger;
  }
) {
  const ownerGuard = [deps.authenticate, deps.requirePermission(Permission.OWNER_DASHBOARD_VIEW)];

  app.get("/api/v1/owner/overview", { preHandler: ownerGuard }, async (_request, reply) => {
    const [accounts, commissionRules, settings] = await Promise.all([
      deps.platformStore.getGameAccounts(),
      deps.platformStore.getCommissionRules(),
      deps.platformStore.getSettings(),
    ]);

    return reply.code(200).send({
      portal: "owner",
      primarySupplier: PRIMARY_SUPPLIER_USERNAME,
      accounts,
      commissionRules,
      settings,
    });
  });

  app.get(
    "/api/v1/owner/audit-logs",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_AUDIT_LOG_READ)] },
    async (request, reply) => {
      const limitParam = Number((request.query as { limit?: string })?.limit ?? 50);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
      const logs = await deps.audit.listRecent(limit);
      return reply.code(200).send({ logs });
    }
  );

  app.put(
    "/api/v1/owner/settings/:key",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (request, reply) => {
      const key = (request.params as { key: string }).key;
      const parsed = updateSettingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid setting update payload.", details: parsed.error.flatten() });
      }

      const existing = (await deps.platformStore.getSettings()).find((s) => s.key === key) ?? null;
      const updated = await deps.platformStore.upsertSetting(key, parsed.data.value, request.auth!.userId);

      await deps.audit.record({
        actorUserId: request.auth!.userId,
        actionType: "PLATFORM_SETTING_UPDATED",
        targetEntity: "PLATFORM_SETTING",
        targetId: key,
        beforeState: existing ? { value: existing.value } : null,
        afterState: { value: updated.value },
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });

      return reply.code(200).send({ setting: updated });
    }
  );
}

