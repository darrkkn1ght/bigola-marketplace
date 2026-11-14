import type { FastifyInstance } from "fastify";
import { PRIMARY_SUPPLIER_USERNAME } from "@bigola/shared";
import type { QueueInfrastructure } from "../lib/redis.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { queues: QueueInfrastructure; checkDb: () => Promise<boolean> }
) {
  app.get("/api/v1/health", async (_request, reply) => {
    const [dbOk, redisOk] = await Promise.all([deps.checkDb(), deps.queues.ping()]);
    return reply.code(200).send({
      status: "ok",
      service: "bigola-marketplace-api",
      supplier: PRIMARY_SUPPLIER_USERNAME,
      dependencies: {
        postgres: dbOk ? "connected" : "unavailable",
        redis: redisOk ? "connected" : "unavailable",
      },
      disbursementEnabled: false,
    });
  });
}

