import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { NotificationService } from "../services/notification.js";

export function registerNotificationRoutes(
  app: FastifyInstance,
  deps: {
    authenticate: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["authenticate"];
    prisma?: PrismaClient;
    notificationService?: NotificationService;
  }
) {
  const getSvc = () => {
    if (deps.notificationService) return deps.notificationService;
    if (deps.prisma) return new NotificationService(deps.prisma);
    return null;
  };

  app.get("/api/v1/notifications", { preHandler: [deps.authenticate] }, async (request, reply) => {
    const svc = getSvc();
    if (!svc) {
      return reply.code(503).send({ error: "Notification service unavailable." });
    }
    const query = request.query as { limit?: string; unreadOnly?: string };
    const limitParam = Number(query?.limit ?? 50);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 50;
    const unreadOnly = query?.unreadOnly === "true";
    const data = await svc.listForUser(request.auth!.userId, { limit, unreadOnly });
    return reply.code(200).send(data);
  });

  app.post(
    "/api/v1/notifications/read-all",
    { preHandler: [deps.authenticate] },
    async (request, reply) => {
      const svc = getSvc();
      if (!svc) {
        return reply.code(503).send({ error: "Notification service unavailable." });
      }
      const result = await svc.markAllRead(request.auth!.userId);
      return reply.code(200).send(result);
    }
  );

  app.post(
    "/api/v1/notifications/:id/read",
    { preHandler: [deps.authenticate] },
    async (request, reply) => {
      const svc = getSvc();
      if (!svc) {
        return reply.code(503).send({ error: "Notification service unavailable." });
      }
      const { id } = request.params as { id: string };
      const updated = await svc.markRead(id, request.auth!.userId);
      if (!updated) {
        return reply.code(404).send({ error: "Notification not found." });
      }
      return reply.code(200).send({ read: true });
    }
  );
}

