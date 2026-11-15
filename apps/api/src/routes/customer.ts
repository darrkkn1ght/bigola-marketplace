import type { FastifyInstance } from "fastify";
import {
  OrderChannel,
  OrderType,
  PrismaClient,
  SupportTicketCategory,
  SupportTicketPriority,
} from "@prisma/client";
import { z } from "zod";
import { Permission, normalizeLagoslifeUsername, normalizePhone } from "@bigola/shared";
import { CommissionService } from "../services/commission.js";
import { NotificationService } from "../services/notification.js";
import { OrderError, OrderService, serializeOrder } from "../services/order.js";
import { SupportError, SupportService } from "../services/support.js";
import { VerificationError, VerificationService } from "../services/verification.js";

const submitPaymentProofSchema = z.object({
  receivingBankAccountId: z.string().uuid(),
  bankReference: z.string().min(3).max(120),
  senderAccountName: z.string().min(2).max(120),
  claimedAmountKobo: z.string().regex(/^\d+$/),
  transferTimestamp: z.string().optional(),
  proofFileKey: z.string().min(2).max(255),
  proofMimeType: z.string().max(80).optional(),
  proofSha256: z.string().max(128).optional(),
  isSplitTransfer: z.boolean().optional(),
});

const createCustomerOrderSchema = z.object({
  orderType: z.enum(["BULK", "RETAIL"]).default("BULK"),
  gameAmount: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  packageId: z.string().min(1).max(64).optional(),
  recipientLagoslifeUsername: z.string().min(2).max(60),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const cancelCustomerOrderSchema = z.object({
  reason: z.string().min(3).max(300).optional(),
});

export function registerCustomerRoutes(
  app: FastifyInstance,
  deps: {
    authenticate: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["authenticate"];
    requirePermission: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["requirePermission"];
    prisma?: PrismaClient;
    orderService?: OrderService;
    verificationService?: VerificationService;
  }
) {
  const getOrderService = () => {
    if (deps.orderService) return deps.orderService;
    if (deps.prisma) return new OrderService(deps.prisma);
    return null;
  };
  const getVerificationService = () => {
    if (deps.verificationService) return deps.verificationService;
    if (deps.prisma) {
      return new VerificationService(
        deps.prisma,
        new CommissionService(deps.prisma),
        new NotificationService(deps.prisma)
      );
    }
    return null;
  };

  app.get("/api/v1/catalog/pricing", async (_request, reply) => {
    const orderService = getOrderService();
    if (!orderService) {
      return reply.code(503).send({ error: "Order service unavailable." });
    }
    const catalog = await orderService.getCatalogPricing();
    return reply.code(200).send(catalog);
  });

  app.get(
    "/api/v1/customer/overview",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_VIEW_OWN)] },
    async (request, reply) => {
      return reply.code(200).send({
        portal: "customer",
        userId: request.auth!.userId,
        phaseStatus: "PHASE_4_ORDERS_AND_INVENTORY",
      });
    }
  );

  app.post(
    "/api/v1/orders",
    {
      preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_CREATE_OWN)],
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const orderService = getOrderService();
      if (!deps.prisma || !orderService) {
        return reply.code(503).send({ error: "Order service unavailable." });
      }

      const parsed = createCustomerOrderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid order request payload.", issues: parsed.error.issues });
      }

      const customer = await deps.prisma.customer.findUnique({
        where: { userId: request.auth!.userId },
      });
      if (!customer) {
        return reply.code(404).send({ error: "Customer profile not found." });
      }

      const headerKey =
        typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"]
          : undefined;
      const idempotencyKey = headerKey ?? parsed.data.idempotencyKey;

      try {
        const result = await orderService.createOrder({
          actorUserId: request.auth!.userId,
          channel: OrderChannel.ONLINE,
          customerId: customer.id,
          orderType: parsed.data.orderType as OrderType,
          gameAmount: parsed.data.gameAmount ? BigInt(parsed.data.gameAmount) : undefined,
          packageId: parsed.data.packageId,
          recipientLagoslifeUsername: parsed.data.recipientLagoslifeUsername,
          idempotencyKey,
        });
        return reply.code(result.idempotentReplay ? 200 : 201).send({
          idempotentReplay: result.idempotentReplay,
          order: serializeOrder(result.order),
        });
      } catch (err) {
        if (err instanceof OrderError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/customer/orders",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_VIEW_OWN)] },
    async (request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Database service unavailable." });
      }
      const customer = await deps.prisma.customer.findUnique({
        where: { userId: request.auth!.userId },
      });
      if (!customer) {
        return reply.code(404).send({ error: "Customer profile not found." });
      }

      const orders = await deps.prisma.order.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { reservations: true },
      });

      return reply.code(200).send({
        orders: orders.map(serializeOrder),
      });
    }
  );

  app.get(
    "/api/v1/customer/orders/:orderId",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_VIEW_OWN)] },
    async (request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Database service unavailable." });
      }
      const { orderId } = request.params as { orderId: string };
      const customer = await deps.prisma.customer.findUnique({
        where: { userId: request.auth!.userId },
      });
      if (!customer) {
        return reply.code(404).send({ error: "Customer profile not found." });
      }

      const order = await deps.prisma.order.findUnique({
        where: { id: orderId },
        include: { reservations: true },
      });
      if (!order || order.customerId !== customer.id) {
        return reply.code(404).send({ error: "Order not found." });
      }

      return reply.code(200).send({ order: serializeOrder(order) });
    }
  );

  app.post(
    "/api/v1/customer/orders/:orderId/cancel",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_VIEW_OWN)] },
    async (request, reply) => {
      const orderService = getOrderService();
      if (!deps.prisma || !orderService) {
        return reply.code(503).send({ error: "Order service unavailable." });
      }

      const { orderId } = request.params as { orderId: string };
      const customer = await deps.prisma.customer.findUnique({
        where: { userId: request.auth!.userId },
      });
      if (!customer) {
        return reply.code(404).send({ error: "Customer profile not found." });
      }

      const parsed = cancelCustomerOrderSchema.safeParse(request.body ?? {});
      const reason = parsed.success && parsed.data.reason ? parsed.data.reason : "Cancelled by customer";

      try {
        const cancelled = await orderService.cancelOrder({
          orderId,
          actorUserId: request.auth!.userId,
          requireCustomerId: customer.id,
          reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({ order: serializeOrder(cancelled) });
      } catch (err) {
        if (err instanceof OrderError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/orders/:orderId/payment-instructions",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_VIEW_OWN)] },
    async (request, reply) => {
      const verificationService = getVerificationService();
      if (!verificationService) {
        return reply.code(503).send({ error: "Verification service unavailable." });
      }
      const { orderId } = request.params as { orderId: string };
      try {
        const instructions = await verificationService.getPaymentInstructionsForOrder(
          orderId,
          request.auth!.userId
        );
        return reply.code(200).send(instructions);
      } catch (err) {
        if (err instanceof VerificationError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/orders/:orderId/payment-proof",
    {
      preHandler: [deps.authenticate, deps.requirePermission(Permission.PAYMENT_PROOF_SUBMIT_OWN)],
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const verificationService = getVerificationService();
      if (!verificationService) {
        return reply.code(503).send({ error: "Verification service unavailable." });
      }
      const { orderId } = request.params as { orderId: string };
      const parsed = submitPaymentProofSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid payment proof payload.", issues: parsed.error.issues });
      }
      try {
        const result = await verificationService.submitPaymentProof({
          orderId,
          customerUserId: request.auth!.userId,
          receivingBankAccountId: parsed.data.receivingBankAccountId,
          bankReference: parsed.data.bankReference,
          senderAccountName: parsed.data.senderAccountName,
          claimedAmountKobo: BigInt(parsed.data.claimedAmountKobo),
          transferTimestamp: parsed.data.transferTimestamp,
          proofFileKey: parsed.data.proofFileKey,
          proofMimeType: parsed.data.proofMimeType,
          proofSha256: parsed.data.proofSha256,
          isSplitTransfer: parsed.data.isSplitTransfer,
        });
        return reply.code(201).send({
          proof: {
            id: result.proof.id,
            verificationStatus: result.proof.verificationStatus,
          },
          order: serializeOrder(result.order),
        });
      } catch (err) {
        if (err instanceof VerificationError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/customer/profile",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_VIEW_OWN)] },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const customer = await deps.prisma.customer.findUnique({
        where: { userId: request.auth!.userId },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          lagoslifeUsername: true,
          category: true,
          attributionSource: true,
          attributedPartner: { select: { displayName: true, referralCode: true } },
        },
      });
      if (!customer) return reply.code(404).send({ error: "Customer profile not found." });
      return reply.code(200).send({ profile: customer });
    }
  );

  app.patch(
    "/api/v1/customer/profile",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_VIEW_OWN)] },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const parsed = z
        .object({
          fullName: z.string().min(2).max(120).optional(),
          phone: z.string().min(7).max(20).optional(),
          lagoslifeUsername: z.string().min(2).max(60).optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid profile update payload.", issues: parsed.error.issues });
      }

      const existing = await deps.prisma.customer.findUnique({
        where: { userId: request.auth!.userId },
      });
      if (!existing) return reply.code(404).send({ error: "Customer profile not found." });

      const updated = await deps.prisma.$transaction(async (tx) => {
        const nextPhone = parsed.data.phone !== undefined ? normalizePhone(parsed.data.phone) : existing.phone;
        const nextLagoslife =
          parsed.data.lagoslifeUsername !== undefined
            ? normalizeLagoslifeUsername(parsed.data.lagoslifeUsername)
            : existing.lagoslifeUsername;

        const c = await tx.customer.update({
          where: { id: existing.id },
          data: {
            ...(parsed.data.fullName ? { fullName: parsed.data.fullName.trim() } : {}),
            ...(parsed.data.phone !== undefined ? { phone: nextPhone } : {}),
            ...(parsed.data.lagoslifeUsername !== undefined ? { lagoslifeUsername: nextLagoslife } : {}),
          },
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            lagoslifeUsername: true,
            category: true,
            attributionSource: true,
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: request.auth!.userId,
            actionType: "CUSTOMER_PROFILE_UPDATED",
            targetEntity: "CUSTOMER",
            targetId: existing.id,
            beforeState: {
              fullName: existing.fullName,
              lagoslifeUsername: existing.lagoslifeUsername,
            },
            afterState: {
              fullName: c.fullName,
              lagoslifeUsername: c.lagoslifeUsername,
            },
            ipAddress: request.ip ?? null,
          },
        });

        return c;
      });

      return reply.code(200).send({ profile: updated });
    }
  );

  // --- Phase 7: Customer Support & Dispute Requests ---

  app.get(
    "/api/v1/customer/support/tickets",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.SUPPORT_TICKET_OWN)] },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const customer = await deps.prisma.customer.findUnique({
        where: { userId: request.auth!.userId },
      });
      if (!customer) return reply.code(404).send({ error: "Customer profile not found." });
      const svc = new SupportService(deps.prisma);
      const tickets = await svc.listCustomerTickets(customer.id);
      return reply.code(200).send({ tickets });
    }
  );

  app.post(
    "/api/v1/customer/support/tickets",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.SUPPORT_TICKET_OWN)] },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const customer = await deps.prisma.customer.findUnique({
        where: { userId: request.auth!.userId },
      });
      if (!customer) return reply.code(404).send({ error: "Customer profile not found." });
      const parsed = z
        .object({
          orderId: z.string().uuid().optional(),
          category: z.nativeEnum(SupportTicketCategory),
          priority: z.nativeEnum(SupportTicketPriority).optional(),
          subject: z.string().min(3).max(160),
          body: z.string().min(3).max(2000),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid support ticket payload.", issues: parsed.error.issues });
      }
      const svc = new SupportService(deps.prisma);
      try {
        const ticket = await svc.createTicket({
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          customerId: customer.id,
          partnerId: customer.attributedPartnerId,
          orderId: parsed.data.orderId,
          category: parsed.data.category,
          priority: parsed.data.priority,
          subject: parsed.data.subject,
          body: parsed.data.body,
          ipAddress: request.ip,
        });
        return reply.code(201).send({ ticket });
      } catch (err) {
        if (err instanceof SupportError) return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/customer/support/tickets/:id",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.SUPPORT_TICKET_OWN)] },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const customer = await deps.prisma.customer.findUnique({
        where: { userId: request.auth!.userId },
      });
      if (!customer) return reply.code(404).send({ error: "Customer profile not found." });
      const { id } = request.params as { id: string };
      const svc = new SupportService(deps.prisma);
      try {
        const ticket = await svc.getTicketForActor({
          ticketId: id,
          actorRole: request.auth!.role,
          customerId: customer.id,
        });
        return reply.code(200).send({ ticket });
      } catch (err) {
        if (err instanceof SupportError) return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/customer/support/tickets/:id/messages",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.SUPPORT_TICKET_OWN)] },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const customer = await deps.prisma.customer.findUnique({
        where: { userId: request.auth!.userId },
      });
      if (!customer) return reply.code(404).send({ error: "Customer profile not found." });
      const { id } = request.params as { id: string };
      const parsed = z.object({ body: z.string().min(1).max(2000) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Message body required." });
      const svc = new SupportService(deps.prisma);
      try {
        const message = await svc.addMessage({
          ticketId: id,
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          customerId: customer.id,
          body: parsed.data.body,
          isInternal: false,
          ipAddress: request.ip,
        });
        return reply.code(201).send({ message });
      } catch (err) {
        if (err instanceof SupportError) return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        throw err;
      }
    }
  );

  // --- Stage 8B: Customer Order Transfer Progress ---
  app.get(
    "/api/v1/customer/orders/:orderId/disbursements",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_VIEW_OWN)] },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const customer = await deps.prisma.customer.findUnique({
        where: { userId: request.auth!.userId },
      });
      if (!customer) return reply.code(404).send({ error: "Customer profile not found." });

      const { orderId } = request.params as { orderId: string };
      const order = await deps.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          disbursementJobs: {
            orderBy: { createdAt: "desc" },
          },
        },
      });

      if (!order || order.customerId !== customer.id) {
        return reply.code(404).send({ error: "Order not found." });
      }

      const jobs = order.disbursementJobs.map((j) => {
        const total = BigInt(j.totalAmount.toFixed(0));
        const delivered = BigInt(j.deliveredAmount.toFixed(0));
        const remaining = total > delivered ? total - delivered : 0n;
        const progressPercent =
          j.totalChunks > 0 ? Math.round((j.completedChunks / j.totalChunks) * 100) : 0;
        return {
          id: j.id,
          orderId: j.orderId,
          status: j.status,
          totalAmount: total.toString(),
          deliveredAmount: delivered.toString(),
          remainingAmount: remaining.toString(),
          totalChunks: j.totalChunks,
          completedChunks: j.completedChunks,
          progressPercent,
          startedAt: j.startedAt ? j.startedAt.toISOString() : null,
          completedAt: j.completedAt ? j.completedAt.toISOString() : null,
          createdAt: j.createdAt.toISOString(),
        };
      });

      return reply.code(200).send({
        orderId: order.id,
        orderStatus: order.status,
        gameAmountRequested: order.gameAmountRequested.toFixed(0),
        fulfilledAmount: order.fulfilledAmount.toFixed(0),
        jobs,
      });
    }
  );
}
