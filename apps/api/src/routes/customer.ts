import type { FastifyInstance } from "fastify";
import { Permission } from "@bigola/shared";

export function registerCustomerRoutes(
  app: FastifyInstance,
  deps: {
    authenticate: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["authenticate"];
    requirePermission: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["requirePermission"];
  }
) {
  app.get(
    "/api/v1/customer/overview",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_VIEW_OWN)] },
    async (request, reply) => {
      return reply.code(200).send({
        portal: "customer",
        userId: request.auth!.userId,
        phaseStatus: "PHASE_2_FOUNDATION",
      });
    }
  );
}

