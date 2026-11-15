import type { FastifyInstance } from "fastify";
import {
  OrderStatus,
  PrismaClient,
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketStatus,
} from "@prisma/client";
import { Permission } from "@bigola/shared";
import { z } from "zod";
import { InventoryService } from "../services/inventory.js";
import { OperationsError, OperationsService } from "../services/operations.js";
import { SupportError, SupportService } from "../services/support.js";

const confirmFulfilmentSchema = z.object({
  sourceGameAccountId: z.string().uuid(),
  deliveredAmount: z.string().regex(/^\d+$/),
  externalReference: z.string().min(3).max(120),
  idempotencyKey: z.string().min(3).max(120).optional(),
  notes: z.string().max(500).optional(),
});

const supportMessageSchema = z.object({
  body: z.string().min(1).max(2000),
  isInternal: z.boolean().optional().default(false),
});

const updateSupportStatusSchema = z.object({
  status: z.nativeEnum(SupportTicketStatus),
  assignedToUserId: z.string().uuid().nullable().optional(),
  resolutionSummary: z.string().max(1000).optional(),
});

export function registerOpsRoutes(
  app: FastifyInstance,
  deps: {
    authenticate: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["authenticate"];
    requirePermission: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["requirePermission"];
    prisma?: PrismaClient;
    operationsService?: OperationsService;
    inventoryService?: InventoryService;
    supportService?: SupportService;
    disbursementEnabled?: boolean;
    encryptionKeyHex?: string;
  }
) {
  const opsOrderGuard = [deps.authenticate, deps.requirePermission(Permission.ORDER_VIEW_ALL)];
  const opsSupportGuard = [
    deps.authenticate,
    deps.requirePermission(Permission.SUPPORT_TICKET_MANAGE),
  ];

  const getOpsSvc = () =>
    deps.operationsService ??
    (deps.prisma ? new OperationsService(deps.prisma, deps.disbursementEnabled ?? false) : null);
  const getInvSvc = () =>
    deps.inventoryService ??
    (deps.prisma
      ? new InventoryService(deps.prisma, { encryptionKeyHex: deps.encryptionKeyHex })
      : null);
  const getSupportSvc = () =>
    deps.supportService ?? (deps.prisma ? new SupportService(deps.prisma) : null);

  app.get("/api/v1/ops/orders", { preHandler: opsOrderGuard }, async (request, reply) => {
    if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
    const q = request.query as { status?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q?.limit ?? 50) || 50, 1), 200);
    const status =
      q?.status && Object.values(OrderStatus).includes(q.status as OrderStatus)
        ? (q.status as OrderStatus)
        : undefined;

    const orders = await deps.prisma.order.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        customer: { select: { id: true, fullName: true, lagoslifeUsername: true } },
        partner: { select: { id: true, displayName: true, referralCode: true } },
      },
    });

    return reply.code(200).send({
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        channel: o.channel,
        status: o.status,
        refundFinancialStatus: o.refundFinancialStatus,
        recipientLagoslifeUsername: o.recipientLagoslifeUsername,
        gameAmountRequested: o.gameAmountRequested.toFixed(0),
        fulfilledAmount: o.fulfilledAmount.toFixed(0),
        fiatAmountKobo: o.fiatAmountKobo.toString(),
        verifiedGrossFiatKobo: o.verifiedGrossFiatKobo.toString(),
        confirmedRefundedKobo: o.confirmedRefundedKobo.toString(),
        customer: o.customer,
        partner: o.partner,
        createdAt: o.createdAt.toISOString(),
      })),
    });
  });

  app.get("/api/v1/ops/orders/:orderId", { preHandler: opsOrderGuard }, async (request, reply) => {
    const svc = getOpsSvc();
    if (!svc) return reply.code(503).send({ error: "Operations service unavailable." });
    const { orderId } = request.params as { orderId: string };
    try {
      const detail = await svc.getOrderOperationalDetail(orderId);
      return reply.code(200).send({ order: detail });
    } catch (err) {
      if (err instanceof OperationsError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.post(
    "/api/v1/ops/orders/:orderId/confirm-fulfilment",
    { preHandler: opsOrderGuard },
    async (request, reply) => {
      const svc = getOpsSvc();
      if (!svc) return reply.code(503).send({ error: "Operations service unavailable." });
      const { orderId } = request.params as { orderId: string };
      const parsed = confirmFulfilmentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid manual fulfilment payload.",
          details: parsed.error.flatten(),
        });
      }

      const headerIdem = request.headers["idempotency-key"];
      const idempotencyKey =
        (typeof headerIdem === "string" && headerIdem.trim()) || parsed.data.idempotencyKey;
      if (!idempotencyKey) {
        return reply.code(400).send({
          error: "Idempotency-Key header or idempotencyKey field is required.",
        });
      }

      try {
        const result = await svc.confirmManualFulfilment({
          orderId,
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          sourceGameAccountId: parsed.data.sourceGameAccountId,
          deliveredAmount: BigInt(parsed.data.deliveredAmount),
          externalReference: parsed.data.externalReference,
          idempotencyKey,
          notes: parsed.data.notes,
          ipAddress: request.ip,
        });
        return reply.code(result.idempotentReplay ? 200 : 201).send(result);
      } catch (err) {
        if (err instanceof OperationsError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.get("/api/v1/ops/inventory", { preHandler: opsOrderGuard }, async (_request, reply) => {
    const svc = getInvSvc();
    if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
    const overview = await svc.getInventoryOverview();
    return reply.code(200).send(overview);
  });

  app.get("/api/v1/ops/support/tickets", { preHandler: opsSupportGuard }, async (request, reply) => {
    const svc = getSupportSvc();
    if (!svc) return reply.code(503).send({ error: "Support service unavailable." });
    const q = request.query as { status?: string; category?: string; priority?: string };
    const tickets = await svc.listStaffTickets({
      status:
        q?.status && Object.values(SupportTicketStatus).includes(q.status as SupportTicketStatus)
          ? (q.status as SupportTicketStatus)
          : undefined,
      category:
        q?.category &&
        Object.values(SupportTicketCategory).includes(q.category as SupportTicketCategory)
          ? (q.category as SupportTicketCategory)
          : undefined,
      priority:
        q?.priority &&
        Object.values(SupportTicketPriority).includes(q.priority as SupportTicketPriority)
          ? (q.priority as SupportTicketPriority)
          : undefined,
    });
    return reply.code(200).send({ tickets });
  });

  app.get(
    "/api/v1/ops/support/tickets/:id",
    { preHandler: opsSupportGuard },
    async (request, reply) => {
      const svc = getSupportSvc();
      if (!svc) return reply.code(503).send({ error: "Support service unavailable." });
      const { id } = request.params as { id: string };
      try {
        const ticket = await svc.getTicketForActor({
          ticketId: id,
          actorRole: request.auth!.role,
        });
        return reply.code(200).send({ ticket });
      } catch (err) {
        if (err instanceof SupportError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/ops/support/tickets/:id/messages",
    { preHandler: opsSupportGuard },
    async (request, reply) => {
      const svc = getSupportSvc();
      if (!svc) return reply.code(503).send({ error: "Support service unavailable." });
      const { id } = request.params as { id: string };
      const parsed = supportMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid message payload.", details: parsed.error.flatten() });
      }
      try {
        const msg = await svc.addMessage({
          ticketId: id,
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          body: parsed.data.body,
          isInternal: parsed.data.isInternal,
          ipAddress: request.ip,
        });
        return reply.code(201).send({ message: msg });
      } catch (err) {
        if (err instanceof SupportError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.patch(
    "/api/v1/ops/support/tickets/:id/status",
    { preHandler: opsSupportGuard },
    async (request, reply) => {
      const svc = getSupportSvc();
      if (!svc) return reply.code(503).send({ error: "Support service unavailable." });
      const { id } = request.params as { id: string };
      const parsed = updateSupportStatusSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid status payload.", details: parsed.error.flatten() });
      }
      try {
        const ticket = await svc.updateTicketStatus({
          ticketId: id,
          actorUserId: request.auth!.userId,
          status: parsed.data.status,
          assignedToUserId: parsed.data.assignedToUserId,
          resolutionSummary: parsed.data.resolutionSummary,
          ipAddress: request.ip,
        });
        return reply.code(200).send({ ticket });
      } catch (err) {
        if (err instanceof SupportError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );
}
