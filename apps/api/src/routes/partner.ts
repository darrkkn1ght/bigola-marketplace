import type { FastifyInstance } from "fastify";
import { Permission } from "@bigola/shared";
import type { PlatformStore } from "../lib/repositories.js";

export function registerPartnerRoutes(
  app: FastifyInstance,
  deps: {
    authenticate: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["authenticate"];
    requirePermission: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["requirePermission"];
    platformStore: PlatformStore;
  }
) {
  const partnerGuard = [deps.authenticate, deps.requirePermission(Permission.PARTNER_DASHBOARD_OWN)];

  app.get("/api/v1/partner/overview", { preHandler: partnerGuard }, async (request, reply) => {
    return reply.code(200).send({
      portal: "partner",
      userId: request.auth!.userId,
      categoryASplit: "50/50 gross verified payment",
      categoryBStatus: "PENDING_RULE",
      phaseStatus: "PHASE_2_FOUNDATION",
    });
  });

  app.get(
    "/api/v1/partner/:partnerId/customers",
    { preHandler: partnerGuard },
    async (request, reply) => {
      const { partnerId } = request.params as { partnerId: string };
      const callerPartner = await deps.platformStore.findPartnerByUserId(request.auth!.userId);
      if (!callerPartner || callerPartner.id !== partnerId) {
        return reply.code(403).send({
          error: "Forbidden: partners can only access their own attributed customer records.",
        });
      }
      const customers = await deps.platformStore.listPartnerCustomers(callerPartner.id);
      return reply.code(200).send({ partnerId: callerPartner.id, customers });
    }
  );
}

