import type { FastifyInstance } from "fastify";
import {
  OrderChannel,
  OrderType,
  PartnerStatus,
  PrismaClient,
  CommissionSettlementStatus,
  SupportTicketCategory,
  SupportTicketPriority,
} from "@prisma/client";
import { z } from "zod";
import { Permission } from "@bigola/shared";
import type { PlatformStore } from "../lib/repositories.js";
import { AnalyticsService } from "../services/analytics.js";
import { AttributionError, type AttributionService } from "../services/attribution.js";
import { CommissionService } from "../services/commission.js";
import { NotificationService } from "../services/notification.js";
import { OrderError, OrderService, serializeOrder } from "../services/order.js";
import { SupportError, SupportService } from "../services/support.js";
import { VerificationError, VerificationService } from "../services/verification.js";

const confirmBankChangeSchema = z.object({
  approve: z.boolean(),
  reason: z.string().min(3).max(500),
});

const partnerProposeBankSchema = z.object({
  actionType: z.enum(["CREATE", "UPDATE", "DEACTIVATE"]),
  receivingBankAccountId: z.string().uuid().optional(),
  proposedData: z.object({
    bankName: z.string().min(2).max(60).optional(),
    bankCode: z.string().max(20).optional(),
    accountNumber: z.string().min(6).max(20).optional(),
    accountName: z.string().min(2).max(120).optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  }),
  reason: z.string().min(3).max(500),
});

const offlineOrderSchema = z.object({
  customerId: z.string().uuid(),
  orderType: z.enum(["BULK", "RETAIL"]).default("BULK"),
  gameAmount: z.string().regex(/^\d+$/).optional(),
  packageId: z.string().min(1).max(64).optional(),
  recipientLagoslifeUsername: z.string().min(2).max(60),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const offlineCustomerSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email().optional(),
  phone: z.string().min(7).max(20).optional(),
  lagoslifeUsername: z.string().min(2).max(60).optional(),
});

export function registerPartnerRoutes(
  app: FastifyInstance,
  deps: {
    authenticate: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["authenticate"];
    requirePermission: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["requirePermission"];
    platformStore: PlatformStore;
    attributionService?: AttributionService;
    orderService?: OrderService;
    verificationService?: VerificationService;
    prisma?: PrismaClient;
    webBaseUrl: string;
  }
) {
  const partnerGuard = [deps.authenticate, deps.requirePermission(Permission.PARTNER_DASHBOARD_OWN)];

  app.get("/api/v1/partner/overview", { preHandler: partnerGuard }, async (request, reply) => {
    return reply.code(200).send({
      portal: "partner",
      userId: request.auth!.userId,
      categoryASplit: "50/50 gross verified payment",
      categoryBStatus: "PENDING_RULE",
      phaseStatus: "PHASE_3_ATTRIBUTION_AND_PARTNERS",
    });
  });

  app.get("/api/v1/partner/dashboard", { preHandler: partnerGuard }, async (request, reply) => {
    if (!deps.prisma) {
      return reply.code(503).send({ error: "Database service unavailable." });
    }
    const partner = await deps.prisma.partner.findUnique({
      where: { userId: request.auth!.userId },
    });
    if (!partner) {
      return reply.code(404).send({ error: "Partner profile not found." });
    }

    const [customerCount, orderCount, records] = await Promise.all([
      deps.prisma.customer.count({ where: { attributedPartnerId: partner.id } }),
      deps.prisma.order.count({ where: { partnerId: partner.id } }),
      deps.prisma.commissionRecord.findMany({
        where: { partnerId: partner.id },
        select: {
          grossFiatKobo: true,
          partnerEntitlementKobo: true,
          settlementStatus: true,
          ledgerEntries: {
            select: {
              partnerDeltaKobo: true,
            },
          },
        },
      }),
    ]);

    let accruedKobo = 0n;
    let approvedForPayoutKobo = 0n;
    let paidKobo = 0n;
    let grossReferredSalesKobo = 0n;

    for (const r of records) {
      const share =
        r.ledgerEntries.length > 0
          ? r.ledgerEntries.reduce((sum, e) => sum + e.partnerDeltaKobo, 0n)
          : (r.partnerEntitlementKobo ?? 0n);
      if (r.settlementStatus !== CommissionSettlementStatus.REVERSED) {
        grossReferredSalesKobo += r.grossFiatKobo;
      }
      if (r.settlementStatus === CommissionSettlementStatus.ACCRUED) {
        accruedKobo += share;
      } else if (r.settlementStatus === CommissionSettlementStatus.APPROVED_FOR_PAYOUT) {
        approvedForPayoutKobo += share;
      } else if (r.settlementStatus === CommissionSettlementStatus.PAID) {
        paidKobo += share;
      }
    }

    return reply.code(200).send({
      partner: {
        id: partner.id,
        displayName: partner.displayName,
        referralCode: partner.referralCode,
        referralUrl: `${deps.webBaseUrl.replace(/\/$/, "")}/marketplace?ref=${partner.referralCode}`,
        status: partner.status,
      },
      metrics: {
        attributedCustomers: customerCount,
        totalOrders: orderCount,
        grossReferredSalesKobo: grossReferredSalesKobo.toString(),
        accruedKobo: accruedKobo.toString(),
        approvedForPayoutKobo: approvedForPayoutKobo.toString(),
        paidKobo: paidKobo.toString(),
        categoryBStatus: "PENDING_RULE",
      },
    });
  });

  app.get("/api/v1/partner/customers", { preHandler: partnerGuard }, async (request, reply) => {
    if (!deps.prisma) {
      return reply.code(503).send({ error: "Database service unavailable." });
    }
    const partner = await deps.prisma.partner.findUnique({
      where: { userId: request.auth!.userId },
    });
    if (!partner) {
      return reply.code(404).send({ error: "Partner profile not found." });
    }

    const search = ((request.query as { q?: string })?.q ?? "").trim();
    const customers = await deps.prisma.customer.findMany({
      where: {
        attributedPartnerId: partner.id,
        ...(search
          ? {
              OR: [
                { fullName: { contains: search, mode: "insensitive" } },
                { lagoslifeUsername: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        fullName: true,
        lagoslifeUsername: true,
        category: true,
        attributionSource: true,
        attributedAt: true,
        _count: { select: { orders: true } },
      },
    });

    return reply.code(200).send({ partnerId: partner.id, customers });
  });

  app.get("/api/v1/partner/customers/:customerId/orders", { preHandler: partnerGuard }, async (request, reply) => {
    if (!deps.prisma) {
      return reply.code(503).send({ error: "Database service unavailable." });
    }
    const partner = await deps.prisma.partner.findUnique({
      where: { userId: request.auth!.userId },
    });
    if (!partner) {
      return reply.code(404).send({ error: "Partner profile not found." });
    }

    const { customerId } = request.params as { customerId: string };
    const customer = await deps.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, fullName: true, lagoslifeUsername: true, attributedPartnerId: true },
    });
    if (!customer) {
      return reply.code(404).send({ error: "Customer not found." });
    }
    if (customer.attributedPartnerId !== partner.id) {
      return reply.code(403).send({ error: "Forbidden: customer is not attributed to your partner account." });
    }

    const orders = await deps.prisma.order.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        orderNumber: true,
        paymentReference: true,
        channel: true,
        orderType: true,
        gameAmountRequested: true,
        fiatAmountKobo: true,
        verifiedGrossFiatKobo: true,
        status: true,
        createdAt: true,
      },
    });

    return reply.code(200).send({
      customer: { id: customer.id, fullName: customer.fullName, lagoslifeUsername: customer.lagoslifeUsername },
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        paymentReference: o.paymentReference,
        channel: o.channel,
        orderType: o.orderType,
        gameAmountRequested: o.gameAmountRequested.toString(),
        fiatAmountKobo: o.fiatAmountKobo.toString(),
        verifiedGrossFiatKobo: o.verifiedGrossFiatKobo.toString(),
        status: o.status,
        createdAt: o.createdAt.toISOString(),
      })),
    });
  });

  app.post(
    "/api/v1/partner/customers/offline",
    {
      preHandler: [
        deps.authenticate,
        deps.requirePermission(Permission.PARTNER_OFFLINE_CUSTOMER_REGISTER),
      ],
    },
    async (request, reply) => {
      if (!deps.attributionService) {
        return reply.code(503).send({ error: "Attribution service unavailable." });
      }
      const parsed = offlineCustomerSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid offline customer payload.", details: parsed.error.flatten() });
      }

      try {
        const result = await deps.attributionService.registerOfflineCustomerByPartner({
          partnerUserId: request.auth!.userId,
          fullName: parsed.data.fullName,
          email: parsed.data.email,
          phone: parsed.data.phone,
          lagoslifeUsername: parsed.data.lagoslifeUsername,
          ipAddress: request.ip,
        });

        if (result.status === "CONFLICT") {
          return reply.code(409).send({
            error: "Customer identifier already exists; conflict logged for Owner review.",
            code: "ATTRIBUTION_CONFLICT",
            conflict: result,
          });
        }

        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof AttributionError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.get("/api/v1/partner/commissions", { preHandler: partnerGuard }, async (request, reply) => {
    if (!deps.prisma) {
      return reply.code(503).send({ error: "Database service unavailable." });
    }
    const partner = await deps.prisma.partner.findUnique({
      where: { userId: request.auth!.userId },
    });
    if (!partner) {
      return reply.code(404).send({ error: "Partner profile not found." });
    }

    const records = await deps.prisma.commissionRecord.findMany({
      where: { partnerId: partner.id },
      orderBy: { createdAt: "desc" },
      include: {
        order: { select: { orderNumber: true, status: true } },
        ledgerEntries: { orderBy: { createdAt: "asc" } },
      },
    });

    return reply.code(200).send({
      partnerId: partner.id,
      commissions: records.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        orderNumber: r.order.orderNumber,
        category: r.category,
        grossFiatKobo: r.grossFiatKobo.toString(),
        partnerEntitlementKobo: r.partnerEntitlementKobo?.toString() ?? null,
        ownerEntitlementKobo: r.ownerEntitlementKobo?.toString() ?? null,
        settlementStatus: r.settlementStatus,
        createdAt: r.createdAt,
        ledgerEntries: r.ledgerEntries.map((e) => ({
          id: e.id,
          entryType: e.entryType,
          partnerDeltaKobo: e.partnerDeltaKobo.toString(),
          ownerDeltaKobo: e.ownerDeltaKobo.toString(),
          notes: e.notes,
          createdAt: e.createdAt,
        })),
      })),
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

  app.post(
    "/api/v1/partner/orders",
    {
      preHandler: [deps.authenticate, deps.requirePermission(Permission.PARTNER_ORDER_CREATE)],
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const orderService =
        deps.orderService ?? (deps.prisma ? new OrderService(deps.prisma) : null);
      if (!deps.prisma || !orderService) {
        return reply.code(503).send({ error: "Order service unavailable." });
      }

      const parsed = offlineOrderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid offline order payload.", issues: parsed.error.issues });
      }

      const partner = await deps.prisma.partner.findUnique({
        where: { userId: request.auth!.userId },
      });
      if (!partner || partner.status !== PartnerStatus.ACTIVE) {
        return reply.code(403).send({ error: "Active partner profile required." });
      }

      const customer = await deps.prisma.customer.findUnique({
        where: { id: parsed.data.customerId },
      });
      if (!customer || customer.attributedPartnerId !== partner.id) {
        return reply.code(403).send({
          error: "Forbidden: partners can only create offline orders for their own attributed customers.",
        });
      }

      const headerKey =
        typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"]
          : undefined;
      const idempotencyKey = headerKey ?? parsed.data.idempotencyKey;

      try {
        const result = await orderService.createOrder({
          actorUserId: request.auth!.userId,
          channel: OrderChannel.OFFLINE_PARTNER,
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

  app.get("/api/v1/partner/bank-account-requests", { preHandler: partnerGuard }, async (request, reply) => {
    if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
    const partner = await deps.prisma.partner.findUnique({ where: { userId: request.auth!.userId } });
    if (!partner) return reply.code(404).send({ error: "Partner profile not found." });

    const [accounts, requests] = await Promise.all([
      deps.prisma.receivingBankAccount.findMany({ where: { ownerPartnerId: partner.id } }),
      deps.prisma.receivingBankAccountChangeRequest.findMany({
        where: { ownerPartnerId: partner.id },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return reply.code(200).send({ partnerId: partner.id, canVerifyPayments: partner.canVerifyPayments, accounts, requests });
  });

  app.post("/api/v1/partner/bank-accounts/propose", { preHandler: partnerGuard }, async (request, reply) => {
    const svc = getVerificationService();
    if (!deps.prisma || !svc) return reply.code(503).send({ error: "Service unavailable." });
    const partner = await deps.prisma.partner.findUnique({ where: { userId: request.auth!.userId } });
    if (!partner) return reply.code(404).send({ error: "Partner profile not found." });

    const parsed = partnerProposeBankSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid bank account proposal.", issues: parsed.error.issues });

    try {
      const req = await svc.proposeBankAccountChange({
        actorUserId: request.auth!.userId,
        actorRole: request.auth!.role,
        ownerPartnerId: partner.id,
        actionType: parsed.data.actionType,
        receivingBankAccountId: parsed.data.receivingBankAccountId,
        proposedData: parsed.data.proposedData,
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });
      return reply.code(201).send({ request: req });
    } catch (err) {
      if (err instanceof VerificationError) return reply.code(err.statusCode).send({ code: err.code, error: err.message });
      throw err;
    }
  });

  app.post(
    "/api/v1/partner/bank-account-requests/:requestId/confirm",
    { preHandler: partnerGuard },
    async (request, reply) => {
      const svc = getVerificationService();
      if (!svc) return reply.code(503).send({ error: "Service unavailable." });
      const { requestId } = request.params as { requestId: string };
      const parsed = confirmBankChangeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid confirmation payload.", issues: parsed.error.issues });

      try {
        const result = await svc.confirmBankAccountChange({
          requestId,
          partnerUserId: request.auth!.userId,
          approve: parsed.data.approve,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof VerificationError) return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        throw err;
      }
    }
  );

  // --- Phase 7: Partner Analytics, Activity & Attributed Customer Support ---

  app.get("/api/v1/partner/analytics", { preHandler: partnerGuard }, async (request, reply) => {
    if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
    const partner = await deps.prisma.partner.findUnique({ where: { userId: request.auth!.userId } });
    if (!partner) return reply.code(404).send({ error: "Partner profile not found." });
    const windowDays = Math.min(Math.max(Number((request.query as { days?: string })?.days ?? 30) || 30, 1), 365);
    const svc = new AnalyticsService(deps.prisma);
    const analytics = await svc.getPartnerPerformance(partner.id, windowDays);
    return reply.code(200).send({ analytics });
  });

  app.get("/api/v1/partner/activity", { preHandler: partnerGuard }, async (request, reply) => {
    if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
    const partner = await deps.prisma.partner.findUnique({ where: { userId: request.auth!.userId } });
    if (!partner) return reply.code(404).send({ error: "Partner profile not found." });
    const svc = new AnalyticsService(deps.prisma);
    const activity = await svc.getPartnerActivity(partner.id, request.auth!.userId);
    return reply.code(200).send({ activity });
  });

  app.get("/api/v1/partner/support/tickets", { preHandler: partnerGuard }, async (request, reply) => {
    if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
    const partner = await deps.prisma.partner.findUnique({ where: { userId: request.auth!.userId } });
    if (!partner) return reply.code(404).send({ error: "Partner profile not found." });
    const svc = new SupportService(deps.prisma);
    const tickets = await svc.listPartnerTickets(partner.id);
    return reply.code(200).send({ tickets });
  });

  app.post("/api/v1/partner/support/tickets", { preHandler: partnerGuard }, async (request, reply) => {
    if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
    const partner = await deps.prisma.partner.findUnique({ where: { userId: request.auth!.userId } });
    if (!partner) return reply.code(404).send({ error: "Partner profile not found." });

    const parsed = z
      .object({
        customerId: z.string().uuid(),
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

    const customer = await deps.prisma.customer.findUnique({
      where: { id: parsed.data.customerId },
      select: { id: true, attributedPartnerId: true },
    });
    if (!customer || customer.attributedPartnerId !== partner.id) {
      return reply.code(403).send({ error: "Forbidden: customer is not attributed to your partner account." });
    }

    const svc = new SupportService(deps.prisma);
    try {
      const ticket = await svc.createTicket({
        actorUserId: request.auth!.userId,
        actorRole: request.auth!.role,
        customerId: customer.id,
        partnerId: partner.id,
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
  });

  app.get("/api/v1/partner/support/tickets/:id", { preHandler: partnerGuard }, async (request, reply) => {
    if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
    const partner = await deps.prisma.partner.findUnique({ where: { userId: request.auth!.userId } });
    if (!partner) return reply.code(404).send({ error: "Partner profile not found." });
    const { id } = request.params as { id: string };
    const svc = new SupportService(deps.prisma);
    try {
      const ticket = await svc.getTicketForActor({
        ticketId: id,
        actorRole: request.auth!.role,
        partnerId: partner.id,
      });
      return reply.code(200).send({ ticket });
    } catch (err) {
      if (err instanceof SupportError) return reply.code(err.statusCode).send({ code: err.code, error: err.message });
      throw err;
    }
  });

  app.post(
    "/api/v1/partner/support/tickets/:id/messages",
    { preHandler: partnerGuard },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const partner = await deps.prisma.partner.findUnique({ where: { userId: request.auth!.userId } });
      if (!partner) return reply.code(404).send({ error: "Partner profile not found." });
      const { id } = request.params as { id: string };
      const parsed = z.object({ body: z.string().min(1).max(2000) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Message body required." });
      const svc = new SupportService(deps.prisma);
      try {
        const message = await svc.addMessage({
          ticketId: id,
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          partnerId: partner.id,
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

  // Partner operational readiness (aggregate only; never exposes internal 5-account architecture)
  app.get(
    "/api/v1/partner/readiness",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.PARTNER_DASHBOARD_OWN)] },
    async (_request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Partner readiness requires database." });
      }
      const now = Date.now();
      const [accounts, settings, activeBankCount] = await Promise.all([
        deps.prisma.gameAccount.findMany({
          select: {
            healthStatus: true,
            lastKnownBalance: true,
            reservedForOrders: true,
            lastSyncedAt: true,
          },
        }),
        deps.platformStore.getSettings(),
        deps.prisma.receivingBankAccount.count({ where: { isActive: true } }),
      ]);

      const settingMap = new Map(settings.map((s) => [s.key, s.value as Record<string, unknown>]));
      const freshnessRaw = settingMap.get("inventory_freshness_policy");
      const maxAgeMinutes =
        typeof freshnessRaw?.maxAgeMinutes === "number" && freshnessRaw.maxAgeMinutes > 0
          ? freshnessRaw.maxAgeMinutes
          : 30;
      const bulkRaw = settingMap.get("bulk_pricing");
      const bulkEnabled = bulkRaw?.enabled !== false;
      const bulkPriceValid =
        typeof bulkRaw?.priceKoboPerTrillion === "string" && BigInt(bulkRaw.priceKoboPerTrillion) > 0n;

      let reservableAvailable = 0n;
      for (const acc of accounts) {
        if (acc.healthStatus !== "ACTIVE") continue;
        if (!acc.lastSyncedAt || now - acc.lastSyncedAt.getTime() > maxAgeMinutes * 60_000) continue;
        const obs = BigInt(acc.lastKnownBalance.toFixed(0));
        const res = BigInt(acc.reservedForOrders.toFixed(0));
        if (obs > res) reservableAvailable += obs - res;
      }

      const hasFreshStock = reservableAvailable > 0n;
      const hasPricing = bulkEnabled && bulkPriceValid;
      const hasReceivingBank = activeBankCount > 0;

      return reply.code(200).send({
        readyForFirstOrder: hasFreshStock && hasPricing && hasReceivingBank,
        checks: [
          {
            key: "stock",
            label: "Marketplace Stock Availability",
            status: hasFreshStock ? "READY" : "ACTION_REQUIRED",
            detail: hasFreshStock
              ? "Verified stock is fresh and open for customer orders."
              : "Waiting on Owner to sync fresh LagosLife inventory.",
          },
          {
            key: "pricing",
            label: "Bulk Pricing",
            status: hasPricing ? "READY" : "ACTION_REQUIRED",
            detail: hasPricing ? "Customer pricing is active." : "Customer pricing is not active.",
          },
          {
            key: "receiving_bank",
            label: "OPay Receiving Account",
            status: hasReceivingBank ? "READY" : "ACTION_REQUIRED",
            detail: hasReceivingBank
              ? "Active receiving bank account is live for customer payments."
              : "Owner/Partner must configure and approve an active receiving bank account.",
          },
        ],
      });
    }
  );
}
