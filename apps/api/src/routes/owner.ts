import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AccountTokenType,
  CustomerCategory,
  GameAccountHealth,
  InventoryDiscrepancyStatus,
  OrderChannel,
  OrderStatus,
  OrderType,
  PartnerStatus,
  PrismaClient,
  RefundScope,
  UserRole,
} from "@prisma/client";
import { z } from "zod";
import {
  normalizeEmail,
  normalizeLagoslifeUsername,
  Permission,
  PRIMARY_SUPPLIER_USERNAME,
} from "@bigola/shared";
import type { AuditLogger } from "../lib/audit.js";
import { generateOpaqueToken, hashPassword, hashSessionToken } from "../lib/crypto.js";
import type { PlatformStore } from "../lib/repositories.js";
import { AnalyticsService } from "../services/analytics.js";
import { AttributionError, type AttributionService } from "../services/attribution.js";
import { CommissionService } from "../services/commission.js";
import { InventoryError, InventoryService } from "../services/inventory.js";
import { LagosLifeError } from "../services/lagoslife.js";
import { NotificationService } from "../services/notification.js";
import { OperationsError, OperationsService } from "../services/operations.js";
import { OrderError, OrderService, serializeOrder } from "../services/order.js";
import { VerificationError, VerificationService } from "../services/verification.js";

const updatePartnerVerificationSchema = z.object({
  canVerifyPayments: z.boolean(),
  reason: z.string().min(3).max(500),
});

const proposeOwnerBankChangeSchema = z.object({
  ownerPartnerId: z.string().uuid().optional(),
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

const updateSettingSchema = z.object({
  value: z.record(z.unknown()),
  reason: z.string().min(3).max(500),
});

const createPartnerSchema = z.object({
  email: z.string().email(),
  phone: z.string().min(7).max(20).optional(),
  password: z.string().min(10).max(128).optional(),
  displayName: z.string().min(2).max(120),
  requestedReferralCode: z.string().min(3).max(32).optional(),
});

const updatePartnerStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]),
  reason: z.string().min(3).max(500),
});

const resolveConflictSchema = z.object({
  decision: z.enum(["KEEP_EXISTING", "REASSIGN_TO_REQUESTED", "DISMISS"]),
  reason: z.string().min(5).max(500),
});

const overrideAttributionSchema = z.object({
  targetPartnerId: z.string().uuid().nullable(),
  reason: z.string().min(5).max(500),
});

const updateBulkPricingSchema = z.object({
  priceKoboPerTrillion: z.string().regex(/^\d+$/),
  minBulkGameAmount: z.string().regex(/^\d+$/),
  maxBulkGameAmount: z.string().regex(/^\d+$/).nullable().optional(),
  bulkIncrementGameAmount: z.string().regex(/^\d+$/).optional(),
  promoDiscountBps: z.number().int().min(0).max(9000).optional(),
  promoLabel: z.string().max(80).nullable().optional(),
  tiers: z
    .array(
      z.object({
        minGameAmount: z.string().regex(/^\d+$/),
        priceKoboPerTrillion: z.string().regex(/^\d+$/),
        label: z.string().max(80).optional(),
      })
    )
    .max(20)
    .optional(),
  enabled: z.boolean().default(true),
  reason: z.string().min(3).max(500),
});

const updateRetailPricingSchema = z.object({
  status: z.enum(["UNCONFIGURED", "CONFIGURED"]),
  packages: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(2).max(120),
        gameAmount: z.string().regex(/^\d+$/),
        fiatKobo: z.string().regex(/^\d+$/),
        enabled: z.boolean().default(true),
        promoFiatKobo: z.string().regex(/^\d+$/).nullable().optional(),
        promoLabel: z.string().max(80).nullable().optional(),
      })
    )
    .default([]),
  reason: z.string().min(3).max(500),
});

const updateBusinessSettingsSchema = z.object({
  marketplaceSalesEnabled: z.boolean(),
  retailOrdersEnabled: z.boolean(),
  bulkOrdersEnabled: z.boolean(),
  maintenanceMessage: z.string().max(400).nullable().optional(),
  customerAvailabilityNote: z.string().max(400).nullable().optional(),
  whatsappNumber: z.string().min(7).max(30).nullable().optional(),
  reason: z.string().min(3).max(500),
});

const workerControlSchema = z.object({
  action: z.enum(["PAUSE_INTAKE", "RESUME_INTAKE", "SET_CONCURRENCY"]),
  permittedConcurrency: z.number().int().min(1).max(5).optional(),
  reason: z.string().min(3).max(500),
});

const updateExpiryPolicySchema = z.object({
  unpaidExpiryMinutes: z.number().int().min(1).max(10080).nullable(),
  reason: z.string().min(3).max(500),
});

const updateFreshnessPolicySchema = z.object({
  maxAgeMinutes: z.number().int().min(1).max(10080),
  reason: z.string().min(3).max(500),
});

const updateHoardingPolicySchema = z.object({
  maxActiveUnpaidOrdersPerCustomer: z.number().int().min(1).max(100),
  maxReservedGameAmountPerCustomer: z.string().regex(/^\d+$/),
  reason: z.string().min(3).max(500),
});

const syncInventorySchema = z.object({
  slotCode: z.string().min(2).max(40),
  observedBalance: z.string().regex(/^\d+$/),
  healthStatus: z.nativeEnum(GameAccountHealth).optional(),
  lagoslifeUsername: z.string().min(2).max(60).optional(),
  reason: z.string().min(3).max(500),
});

const allocateLogicalReserveSchema = z.object({
  targetSlotCode: z.string().min(2).max(40),
  logicalAllocationAmount: z.string().regex(/^\d+$/),
  reason: z.string().min(3).max(500),
});

const createOwnerOrderSchema = z.object({
  customerId: z.string().uuid().optional(),
  orderType: z.enum(["BULK", "RETAIL"]).default("BULK"),
  gameAmount: z.string().regex(/^\d+$/).optional(),
  packageId: z.string().min(1).max(64).optional(),
  recipientLagoslifeUsername: z.string().min(2).max(60),
  markPrePaid: z.boolean().optional(),
  reason: z.string().min(3).max(500).optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const cancelOwnerOrderSchema = z.object({
  reason: z.string().min(3).max(500),
});

const authorizeDisbursementSchema = z.object({
  allocations: z
    .array(
      z.object({
        slotCode: z.string().min(2).max(40).optional(),
        gameAccountId: z.string().uuid().optional(),
        amount: z.string().regex(/^\d+$/),
      })
    )
    .optional(),
  authorizationNote: z.string().max(500).optional(),
});

const executeDisbursementSchema = z.object({
  mode: z.enum(["async", "sync"]).optional(),
  maxChunksToProcess: z.number().int().min(1).max(500).optional(),
  waitForCooldown: z.boolean().optional(),
  pinByAccountId: z.record(z.string(), z.string()).optional(),
});

const pauseOrResumeDisbursementSchema = z.object({
  reason: z.string().min(3).max(500).optional(),
});

const cancelDisbursementSchema = z.object({
  reason: z.string().min(3).max(500),
});

const resolveAmbiguousChunkSchema = z.object({
  outcome: z.enum(["CONFIRMED_DELIVERED", "CONFIRMED_NOT_DELIVERED"]),
  notes: z.string().min(3).max(500),
});

export function registerOwnerRoutes(
  app: FastifyInstance,
  deps: {
    authenticate: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["authenticate"];
    requirePermission: ReturnType<typeof import("../middleware/auth.js").createAuthMiddleware>["requirePermission"];
    platformStore: PlatformStore;
    audit: AuditLogger;
    attributionService?: AttributionService;
    orderService?: OrderService;
    inventoryService?: InventoryService;
    disbursementService?: import("../services/disbursement.js").DisbursementService;
    verificationService?: VerificationService;
    operationsService?: OperationsService;
    analyticsService?: AnalyticsService;
    disbursementEnabled?: boolean;
    encryptionKeyHex?: string;
    prisma?: PrismaClient;
    queues?: import("../lib/redis.js").QueueInfrastructure;
  }
) {
  const ownerGuard = [deps.authenticate, deps.requirePermission(Permission.OWNER_DASHBOARD_VIEW)];
  const getOpsSvc = () =>
    deps.operationsService ??
    (deps.prisma ? new OperationsService(deps.prisma, deps.disbursementEnabled ?? false) : null);
  const getAnalyticsSvc = () =>
    deps.analyticsService ?? (deps.prisma ? new AnalyticsService(deps.prisma) : null);
  const getInvSvc = () =>
    deps.inventoryService ??
    (deps.prisma
      ? new InventoryService(deps.prisma, { encryptionKeyHex: deps.encryptionKeyHex })
      : null);
  const getDisbSvc = async () => {
    if (deps.disbursementService) return deps.disbursementService;
    if (!deps.prisma || !deps.encryptionKeyHex) return null;
    const { DisbursementService } = await import("../services/disbursement.js");
    return new DisbursementService(deps.prisma, deps.encryptionKeyHex, undefined, {
      redis: deps.queues?.redis ?? null,
      disbursementEnabled: deps.disbursementEnabled ?? false,
    });
  };

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

  app.get("/api/v1/owner/readiness", { preHandler: ownerGuard }, async (_request, reply) => {
    const now = Date.now();
    const [accounts, settings, activeBankCount] = await Promise.all([
      deps.prisma
        ? deps.prisma.gameAccount.findMany({ orderBy: { slotCode: "asc" } })
        : Promise.resolve([]),
      deps.platformStore.getSettings(),
      deps.prisma
        ? deps.prisma.receivingBankAccount.count({ where: { isActive: true } })
        : Promise.resolve(0),
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
    const retailRaw = settingMap.get("regular_pricing");
    const retailConfigured = retailRaw?.status === "CONFIGURED";

    const configuredAccounts = accounts.filter((a) => Boolean(a.lagoslifeUsername));
    const activeAccounts = accounts.filter((a) => a.healthStatus === GameAccountHealth.ACTIVE);
    const freshActiveAccounts = activeAccounts.filter(
      (a) => a.lastSyncedAt && now - a.lastSyncedAt.getTime() <= maxAgeMinutes * 60_000
    );

    let reservableAvailable = 0n;
    for (const acc of freshActiveAccounts) {
      const obs = BigInt(acc.lastKnownBalance.toFixed(0));
      const res = BigInt(acc.reservedForOrders.toFixed(0));
      if (obs > res) reservableAvailable += obs - res;
    }

    const hasFreshStock = freshActiveAccounts.length > 0 && reservableAvailable > 0n;
    const hasPricing = bulkEnabled && bulkPriceValid;
    const hasReceivingBank = activeBankCount > 0;
    const readyForFirstOrder = hasFreshStock && hasPricing && hasReceivingBank;
    const disbursementEnabled = deps.disbursementEnabled ?? false;

    return reply.code(200).send({
      readyForFirstOrder,
      disbursementEnabled,
      summary: {
        totalAccounts: accounts.length,
        configuredAccounts: configuredAccounts.length,
        activeAccounts: activeAccounts.length,
        freshActiveAccounts: freshActiveAccounts.length,
        reservableAvailable: reservableAvailable.toString(),
        activeReceivingBanks: activeBankCount,
        maxAgeMinutes,
        bulkEnabled,
        retailConfigured,
      },
      checks: [
        {
          key: "game_accounts",
          label: "LagosLife Game Accounts (5 Slots)",
          status:
            configuredAccounts.length >= 5 && activeAccounts.length >= 5
              ? "READY"
              : "ACTION_REQUIRED",
          detail: `${configuredAccounts.length}/${accounts.length || 5} configured, ${activeAccounts.length} ACTIVE.`,
          actionHref: "/owner/inventory",
          actionLabel: "Configure Accounts",
        },
        {
          key: "inventory_freshness",
          label: "Fresh Reservable Stock",
          status: hasFreshStock ? "READY" : "ACTION_REQUIRED",
          detail: hasFreshStock
            ? `${freshActiveAccounts.length} fresh account(s) synced within ${maxAgeMinutes}m.`
            : `No fresh stock available (sync within ${maxAgeMinutes}m required).`,
          actionHref: "/owner/inventory",
          actionLabel: "Sync Balances",
        },
        {
          key: "pricing",
          label: "Customer Pricing",
          status: hasPricing ? "READY" : "ACTION_REQUIRED",
          detail: hasPricing
            ? `Bulk pricing active${retailConfigured ? " • Retail configured" : " • Retail optional"}.`
            : "Bulk pricing must be enabled with a valid rate.",
          actionHref: "/owner/pricing",
          actionLabel: "Review Pricing",
        },
        {
          key: "receiving_bank",
          label: "Active Receiving Bank Account (OPay)",
          status: hasReceivingBank ? "READY" : "ACTION_REQUIRED",
          detail: hasReceivingBank
            ? `${activeBankCount} active receiving account(s) ready for customer transfers.`
            : "No active receiving bank account configured for customer payment instructions.",
          actionHref: "/owner/settings",
          actionLabel: "Configure Bank",
        },
        {
          key: "fulfilment_mode",
          label: "Fulfilment Mode",
          status: "INFO",
          detail: disbursementEnabled
            ? "Automated disbursement enabled."
            : "Manual Fulfilment Mode active (DISBURSEMENT_ENABLED=false) — safe for first launch.",
          actionHref: "/owner/orders",
          actionLabel: "Open Fulfilment Desk",
        },
      ],
    });
  });

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

  app.get(
    "/api/v1/owner/co-owners",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (_request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Database service unavailable." });
      }
      const owners = await deps.prisma.user.findMany({
        where: { role: UserRole.OWNER },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          email: true,
          mfaEnabled: true,
          isActive: true,
          createdAt: true,
        },
      });
      return reply.code(200).send({ owners });
    }
  );

  app.post(
    "/api/v1/owner/co-owners",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Database service unavailable." });
      }
      const parsed = z
        .object({
          email: z.string().email(),
          reason: z.string().min(3).max(500),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Valid email and audit reason are required." });
      }

      const email = normalizeEmail(parsed.data.email);
      const existing = await deps.prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (existing) {
        return reply.code(409).send({ error: "An account with this email already exists." });
      }

      const placeholderHash = await hashPassword(crypto.randomBytes(24).toString("hex"));
      const rawToken = generateOpaqueToken(24);
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const created = await deps.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email,
            passwordHash: placeholderHash,
            role: UserRole.OWNER,
            mfaEnabled: false,
            isActive: true,
          },
          select: { id: true, email: true, role: true, mfaEnabled: true, isActive: true, createdAt: true },
        });
        await tx.accountActionToken.create({
          data: {
            userId: user.id,
            tokenHash,
            type: AccountTokenType.PASSWORD_RESET,
            issuedById: request.auth!.userId,
            expiresAt,
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: request.auth!.userId,
            actionType: "CO_OWNER_INVITED",
            targetEntity: "USER",
            targetId: user.id,
            afterState: { email: user.email, role: user.role },
            reason: parsed.data.reason.trim(),
            ipAddress: request.ip,
          },
        });
        return user;
      });

      return reply.code(201).send({
        owner: created,
        invitePath: `/reset-password?token=${encodeURIComponent(rawToken)}`,
      });
    }
  );

  // --- Phase 3: Owner Partner Management & Commission Oversight ---

  app.post(
    "/api/v1/owner/partners",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_PARTNER_MANAGE)] },
    async (request, reply) => {
      if (!deps.attributionService) {
        return reply.code(503).send({ error: "Attribution service unavailable." });
      }
      const parsed = createPartnerSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid partner creation payload.", details: parsed.error.flatten() });
      }

      try {
        const result = await deps.attributionService.createPartnerAccount({
          ownerUserId: request.auth!.userId,
          email: parsed.data.email,
          phone: parsed.data.phone,
          password: parsed.data.password,
          displayName: parsed.data.displayName,
          requestedReferralCode: parsed.data.requestedReferralCode,
          ipAddress: request.ip,
        });
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof AttributionError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/owner/referral",
    { preHandler: ownerGuard },
    async (request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Database service unavailable." });
      }
      const owner = await deps.prisma.user.findUnique({
        where: { id: request.auth!.userId },
        select: { id: true, referralCode: true },
      });
      if (!owner) {
        return reply.code(404).send({ error: "Owner account not found." });
      }
      const attributedCustomersCount = await deps.prisma.customer.count({
        where: { attributedOwnerUserId: owner.id },
      });
      const baseUrl = (process.env.WEB_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
      return reply.code(200).send({
        referralCode: owner.referralCode ?? null,
        marketplaceUrl: owner.referralCode ? `${baseUrl}/marketplace?ref=${owner.referralCode}` : null,
        registerUrl: owner.referralCode ? `${baseUrl}/register?ref=${owner.referralCode}` : null,
        attributedCustomersCount,
      });
    }
  );

  app.post(
    "/api/v1/owner/referral/generate",
    { preHandler: ownerGuard },
    async (request, reply) => {
      if (!deps.attributionService) {
        return reply.code(503).send({ error: "Attribution service unavailable." });
      }
      const bodySchema = z.object({
        requestedCode: z.string().min(3).max(32).optional(),
      });
      const parsed = bodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid referral code request.", issues: parsed.error.issues });
      }
      try {
        const result = await deps.attributionService.generateOwnerReferralCode({
          ownerUserId: request.auth!.userId,
          requestedCode: parsed.data.requestedCode,
          ipAddress: request.ip,
        });
        const baseUrl = (process.env.WEB_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
        return reply.code(201).send({
          referralCode: result.referralCode,
          marketplaceUrl: `${baseUrl}/marketplace?ref=${result.referralCode}`,
          registerUrl: `${baseUrl}/register?ref=${result.referralCode}`,
        });
      } catch (err) {
        if (err instanceof AttributionError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/owner/partners",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_PARTNER_MANAGE)] },
    async (_request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Database service unavailable." });
      }
      const partners = await deps.prisma.partner.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { email: true, isActive: true } },
          _count: { select: { attributedCustomers: true, orders: true } },
        },
      });
      return reply.code(200).send({ partners });
    }
  );

  app.patch(
    "/api/v1/owner/partners/:id/status",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_PARTNER_MANAGE)] },
    async (request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Database service unavailable." });
      }
      const { id } = request.params as { id: string };
      const parsed = updatePartnerStatusSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid status payload." });
      }

      const existing = await deps.prisma.partner.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: "Partner not found." });
      }

      const updated = await deps.prisma.partner.update({
        where: { id },
        data: { status: parsed.data.status as PartnerStatus },
      });

      await deps.audit.record({
        actorUserId: request.auth!.userId,
        actionType: "PARTNER_STATUS_UPDATED",
        targetEntity: "PARTNER",
        targetId: id,
        beforeState: { status: existing.status },
        afterState: { status: updated.status },
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });

      return reply.code(200).send({ partner: updated });
    }
  );

  app.get(
    "/api/v1/owner/attribution-conflicts",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ATTRIBUTION_OVERRIDE)] },
    async (_request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Database service unavailable." });
      }
      const conflicts = await deps.prisma.attributionConflict.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          existingPartner: { select: { id: true, displayName: true, referralCode: true } },
          requestedPartner: { select: { id: true, displayName: true, referralCode: true } },
        },
      });
      return reply.code(200).send({ conflicts });
    }
  );

  app.post(
    "/api/v1/owner/attribution-conflicts/:id/resolve",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ATTRIBUTION_OVERRIDE)] },
    async (request, reply) => {
      if (!deps.attributionService) {
        return reply.code(503).send({ error: "Attribution service unavailable." });
      }
      const { id } = request.params as { id: string };
      const parsed = resolveConflictSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid conflict resolution payload." });
      }

      try {
        const resolved = await deps.attributionService.resolveAttributionConflict({
          conflictId: id,
          ownerUserId: request.auth!.userId,
          decision: parsed.data.decision,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({ conflict: resolved });
      } catch (err) {
        if (err instanceof AttributionError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/customers/:id/attribution",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ATTRIBUTION_OVERRIDE)] },
    async (request, reply) => {
      if (!deps.attributionService) {
        return reply.code(503).send({ error: "Attribution service unavailable." });
      }
      const { id } = request.params as { id: string };
      const parsed = overrideAttributionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid attribution override payload." });
      }

      try {
        const customer = await deps.attributionService.overrideCustomerAttribution({
          customerId: id,
          ownerUserId: request.auth!.userId,
          targetPartnerId: parsed.data.targetPartnerId,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({ customer });
      } catch (err) {
        if (err instanceof AttributionError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/owner/commissions",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_COMMISSION_VIEW)] },
    async (_request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Database service unavailable." });
      }
      const [rules, records] = await Promise.all([
        deps.prisma.commissionRule.findMany({ orderBy: { effectiveFrom: "desc" } }),
        deps.prisma.commissionRecord.findMany({
          orderBy: { createdAt: "desc" },
          take: 100,
          include: {
            partner: { select: { id: true, displayName: true, referralCode: true } },
            order: { select: { orderNumber: true, status: true } },
          },
        }),
      ]);

      return reply.code(200).send({
        rules,
        records: records.map((r) => ({
          id: r.id,
          orderId: r.orderId,
          orderNumber: r.order.orderNumber,
          category: r.category,
          partner: r.partner,
          grossFiatKobo: r.grossFiatKobo.toString(),
          partnerEntitlementKobo: r.partnerEntitlementKobo?.toString() ?? null,
          ownerEntitlementKobo: r.ownerEntitlementKobo?.toString() ?? null,
          settlementStatus: r.settlementStatus,
          createdAt: r.createdAt,
        })),
      });
    }
  );

  // --- Phase 4: Pricing, Freshness, Hoarding, Inventory & Central Order Management ---

  app.get("/api/v1/owner/business-settings", { preHandler: ownerGuard }, async (_request, reply) => {
    const settings = await deps.platformStore.getSettings();
    const raw = (settings.find((s) => s.key === "business_settings")?.value ?? {}) as Record<
      string,
      unknown
    >;
    return reply.code(200).send({
      businessSettings: {
        marketplaceSalesEnabled: raw.marketplaceSalesEnabled !== false,
        retailOrdersEnabled: raw.retailOrdersEnabled !== false,
        bulkOrdersEnabled: raw.bulkOrdersEnabled !== false,
        maintenanceMessage:
          typeof raw.maintenanceMessage === "string" && raw.maintenanceMessage.trim()
            ? raw.maintenanceMessage.trim()
            : null,
        customerAvailabilityNote:
          typeof raw.customerAvailabilityNote === "string" && raw.customerAvailabilityNote.trim()
            ? raw.customerAvailabilityNote.trim()
            : null,
        whatsappNumber:
          typeof raw.whatsappNumber === "string" && raw.whatsappNumber.trim()
            ? raw.whatsappNumber.trim()
            : null,
      },
    });
  });

  app.put(
    "/api/v1/owner/business-settings",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (request, reply) => {
      const parsed = updateBusinessSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid business settings payload.", issues: parsed.error.issues });
      }
      const nextValue = {
        marketplaceSalesEnabled: parsed.data.marketplaceSalesEnabled,
        retailOrdersEnabled: parsed.data.retailOrdersEnabled,
        bulkOrdersEnabled: parsed.data.bulkOrdersEnabled,
        maintenanceMessage: parsed.data.maintenanceMessage?.trim() || null,
        customerAvailabilityNote: parsed.data.customerAvailabilityNote?.trim() || null,
        whatsappNumber: parsed.data.whatsappNumber?.trim() || null,
      };
      const before =
        (await deps.platformStore.getSettings()).find((s) => s.key === "business_settings") ?? null;
      const updated = await deps.platformStore.upsertSetting(
        "business_settings",
        nextValue,
        request.auth!.userId
      );
      await deps.audit.record({
        actorUserId: request.auth!.userId,
        actionType: "BUSINESS_SETTINGS_UPDATED",
        targetEntity: "platform_settings",
        targetId: "business_settings",
        beforeState: before ? { value: before.value } : null,
        afterState: nextValue,
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });
      return reply.code(200).send({ setting: updated, businessSettings: nextValue });
    }
  );

  app.get("/api/v1/owner/pricing", { preHandler: ownerGuard }, async (_request, reply) => {
    const orderService =
      deps.orderService ?? (deps.prisma ? new OrderService(deps.prisma) : null);
    if (!orderService) {
      return reply.code(503).send({ error: "Order service unavailable." });
    }
    const catalog = await orderService.getCatalogPricing();
    return reply.code(200).send(catalog);
  });

  app.put(
    "/api/v1/owner/pricing/bulk",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (request, reply) => {
      const parsed = updateBulkPricingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid bulk pricing payload.", issues: parsed.error.issues });
      }
      if (BigInt(parsed.data.minBulkGameAmount) < 1_000_000_000_000n) {
        return reply
          .code(400)
          .send({ error: "Minimum bulk order amount cannot be less than 1T (1,000,000,000,000)." });
      }
      if (
        parsed.data.maxBulkGameAmount &&
        BigInt(parsed.data.maxBulkGameAmount) < BigInt(parsed.data.minBulkGameAmount)
      ) {
        return reply
          .code(400)
          .send({ error: "Maximum bulk order amount must be >= minimum bulk order amount." });
      }
      const nextValue = {
        priceKoboPerTrillion: parsed.data.priceKoboPerTrillion,
        minBulkGameAmount: parsed.data.minBulkGameAmount,
        maxBulkGameAmount: parsed.data.maxBulkGameAmount ?? null,
        bulkIncrementGameAmount: parsed.data.bulkIncrementGameAmount ?? "1000000000000",
        promoDiscountBps: parsed.data.promoDiscountBps ?? 0,
        promoLabel: parsed.data.promoLabel?.trim() || null,
        tiers: parsed.data.tiers ?? [],
        enabled: parsed.data.enabled,
        configurableByOwner: true,
      };
      const before = (await deps.platformStore.getSettings()).find((s) => s.key === "bulk_pricing") ?? null;
      const updated = await deps.platformStore.upsertSetting("bulk_pricing", nextValue, request.auth!.userId);
      await deps.audit.record({
        actorUserId: request.auth!.userId,
        actionType: "PRICING_BULK_UPDATED",
        targetEntity: "platform_settings",
        targetId: "bulk_pricing",
        beforeState: before ? { value: before.value } : null,
        afterState: nextValue,
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });
      return reply.code(200).send({ setting: updated });
    }
  );

  app.put(
    "/api/v1/owner/pricing/retail",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (request, reply) => {
      const parsed = updateRetailPricingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid retail pricing payload.", issues: parsed.error.issues });
      }
      const nextValue = {
        status: parsed.data.status,
        packages: parsed.data.packages,
      };
      const before = (await deps.platformStore.getSettings()).find((s) => s.key === "regular_pricing") ?? null;
      const updated = await deps.platformStore.upsertSetting("regular_pricing", nextValue, request.auth!.userId);
      await deps.audit.record({
        actorUserId: request.auth!.userId,
        actionType: "PRICING_RETAIL_UPDATED",
        targetEntity: "platform_settings",
        targetId: "regular_pricing",
        beforeState: before ? { value: before.value } : null,
        afterState: nextValue,
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });
      return reply.code(200).send({ setting: updated });
    }
  );

  app.put(
    "/api/v1/owner/pricing/expiry",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (request, reply) => {
      const parsed = updateExpiryPolicySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid expiry policy payload.", issues: parsed.error.issues });
      }
      const nextValue = {
        status: "CONFIGURED",
        unpaidExpiryMinutes: parsed.data.unpaidExpiryMinutes,
      };
      const before = (await deps.platformStore.getSettings()).find((s) => s.key === "order_expiry_policy") ?? null;
      const updated = await deps.platformStore.upsertSetting("order_expiry_policy", nextValue, request.auth!.userId);
      await deps.audit.record({
        actorUserId: request.auth!.userId,
        actionType: "ORDER_EXPIRY_POLICY_UPDATED",
        targetEntity: "platform_settings",
        targetId: "order_expiry_policy",
        beforeState: before ? { value: before.value } : null,
        afterState: nextValue,
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });
      return reply.code(200).send({ setting: updated });
    }
  );

  app.put(
    "/api/v1/owner/pricing/freshness",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (request, reply) => {
      const parsed = updateFreshnessPolicySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid freshness policy payload.", issues: parsed.error.issues });
      }
      const nextValue = {
        status: "CONFIGURED",
        maxAgeMinutes: parsed.data.maxAgeMinutes,
      };
      const before = (await deps.platformStore.getSettings()).find((s) => s.key === "inventory_freshness_policy") ?? null;
      const updated = await deps.platformStore.upsertSetting("inventory_freshness_policy", nextValue, request.auth!.userId);
      await deps.audit.record({
        actorUserId: request.auth!.userId,
        actionType: "INVENTORY_FRESHNESS_POLICY_UPDATED",
        targetEntity: "platform_settings",
        targetId: "inventory_freshness_policy",
        beforeState: before ? { value: before.value } : null,
        afterState: nextValue,
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });
      return reply.code(200).send({ setting: updated });
    }
  );

  app.put(
    "/api/v1/owner/pricing/hoarding",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (request, reply) => {
      const parsed = updateHoardingPolicySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid hoarding policy payload.", issues: parsed.error.issues });
      }
      const nextValue = {
        status: "CONFIGURED",
        maxActiveUnpaidOrdersPerCustomer: parsed.data.maxActiveUnpaidOrdersPerCustomer,
        maxReservedGameAmountPerCustomer: parsed.data.maxReservedGameAmountPerCustomer,
      };
      const before = (await deps.platformStore.getSettings()).find((s) => s.key === "order_hoarding_policy") ?? null;
      const updated = await deps.platformStore.upsertSetting("order_hoarding_policy", nextValue, request.auth!.userId);
      await deps.audit.record({
        actorUserId: request.auth!.userId,
        actionType: "ORDER_HOARDING_POLICY_UPDATED",
        targetEntity: "platform_settings",
        targetId: "order_hoarding_policy",
        beforeState: before ? { value: before.value } : null,
        afterState: nextValue,
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });
      return reply.code(200).send({ setting: updated });
    }
  );

  app.get("/api/v1/owner/inventory", { preHandler: ownerGuard }, async (_request, reply) => {
    const inventoryService = getInvSvc();
    if (!inventoryService) {
      return reply.code(503).send({ error: "Inventory service unavailable." });
    }
    const overview = await inventoryService.getInventoryOverview();
    return reply.code(200).send(overview);
  });

  app.post(
    "/api/v1/owner/inventory/sync",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ACCOUNT_TOPOLOGY_MANAGE)] },
    async (request, reply) => {
      const inventoryService = getInvSvc();
      if (!inventoryService) {
        return reply.code(503).send({ error: "Inventory service unavailable." });
      }
      const parsed = syncInventorySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid inventory sync payload.", issues: parsed.error.issues });
      }
      try {
        const { account, discrepancy } = await inventoryService.syncAccountBalance({
          actorUserId: request.auth!.userId,
          slotCode: parsed.data.slotCode,
          observedBalance: BigInt(parsed.data.observedBalance),
          healthStatus: parsed.data.healthStatus,
          lagoslifeUsername: parsed.data.lagoslifeUsername,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({
          account: {
            id: account.id,
            slotCode: account.slotCode,
            observedBalance: account.lastKnownBalance.toFixed(0),
            reservedForOrders: account.reservedForOrders.toFixed(0),
            healthStatus: account.healthStatus,
            lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
          },
          discrepancy,
        });
      } catch (err) {
        if (err instanceof InventoryError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/inventory/allocate-reserve",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ACCOUNT_TOPOLOGY_MANAGE)] },
    async (request, reply) => {
      const inventoryService = getInvSvc();
      if (!inventoryService) {
        return reply.code(503).send({ error: "Inventory service unavailable." });
      }
      const parsed = allocateLogicalReserveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid logical allocation payload.", issues: parsed.error.issues });
      }
      try {
        const account = await inventoryService.allocateLogicalReserve({
          actorUserId: request.auth!.userId,
          targetSlotCode: parsed.data.targetSlotCode,
          logicalAllocationAmount: BigInt(parsed.data.logicalAllocationAmount),
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({
          logicalOnly: true,
          account: {
            id: account.id,
            slotCode: account.slotCode,
            logicalAllocationAmount: account.logicalAllocationAmount.toFixed(0),
            observedBalance: account.lastKnownBalance.toFixed(0),
          },
        });
      } catch (err) {
        if (err instanceof InventoryError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/inventory/accounts",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ACCOUNT_TOPOLOGY_MANAGE)] },
    async (request, reply) => {
      const inventoryService = getInvSvc();
      if (!inventoryService) {
        return reply.code(503).send({ error: "Inventory service unavailable." });
      }
      const createReserveSchema = z.object({
        slotCode: z.string().min(3).max(32).optional(),
        lagoslifeUsername: z.string().min(2).max(60).optional(),
        targetReserveAmount: z.string().regex(/^\d+$/).optional(),
        reason: z.string().min(3).max(500).optional(),
      });
      const parsed = createReserveSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid reserve account payload.", issues: parsed.error.issues });
      }
      try {
        const account = await inventoryService.createReserveAccount({
          actorUserId: request.auth!.userId,
          slotCode: parsed.data.slotCode,
          lagoslifeUsername: parsed.data.lagoslifeUsername,
          targetReserveAmount: parsed.data.targetReserveAmount
            ? BigInt(parsed.data.targetReserveAmount)
            : undefined,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(201).send({
          account: {
            id: account.id,
            slotCode: account.slotCode,
            lagoslifeUsername: account.lagoslifeUsername,
            accountRole: account.accountRole,
            healthStatus: account.healthStatus,
            targetReserveAmount: account.targetReserveAmount.toFixed(0),
          },
        });
      } catch (err) {
        if (err instanceof InventoryError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/inventory/refill-reserve",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ACCOUNT_TOPOLOGY_MANAGE)] },
    async (request, reply) => {
      const inventoryService = getInvSvc();
      if (!inventoryService) {
        return reply.code(503).send({ error: "Inventory service unavailable." });
      }
      const refillSchema = z.object({
        targetSlotCode: z.string().min(3).max(32),
        amount: z.string().regex(/^\d+$/),
        confirmTransfer: z.literal(true),
        reason: z.string().min(3).max(500),
      });
      const parsed = refillSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid refill payload. Explicit confirmation, targetSlotCode, amount, and reason are required.",
          issues: parsed.error.issues,
        });
      }
      const amountBig = BigInt(parsed.data.amount);
      if (amountBig <= 0n) {
        return reply.code(400).send({ error: "Refill amount must be positive." });
      }

      const refillId = crypto.randomUUID().slice(0, 12);
      try {
        const stepResult = await inventoryService.executeTreasuryToReserveStep({
          actorUserId: request.auth!.userId,
          targetSlotCode: parsed.data.targetSlotCode,
          remainingAmount: amountBig,
          refillId,
          stepIndex: 1,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });

        let queuedRemaining = false;
        if (
          stepResult.nextDelayMs !== null &&
          BigInt(stepResult.remainingAmount) > 0n &&
          deps.queues?.inventorySyncQueue
        ) {
          await deps.queues.inventorySyncQueue.add(
            "treasury-refill",
            {
              actorUserId: request.auth!.userId,
              targetSlotCode: parsed.data.targetSlotCode,
              remainingAmount: stepResult.remainingAmount,
              refillId,
              stepIndex: 2,
              reason: parsed.data.reason,
              ipAddress: request.ip,
            },
            {
              jobId: `treasury_refill_${refillId}_2`,
              delay: stepResult.nextDelayMs,
              attempts: 1,
            }
          );
          queuedRemaining = true;
        }

        return reply.code(200).send({
          refillId,
          status: stepResult.status,
          chunkAmount: stepResult.chunkAmount,
          remainingAmount: stepResult.remainingAmount,
          queuedRemaining,
          error: stepResult.error ?? null,
        });
      } catch (err) {
        if (err instanceof InventoryError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/owner/orders",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_VIEW_ALL)] },
    async (request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Database service unavailable." });
      }
      const query = request.query as { status?: string; channel?: string };
      const where: Record<string, unknown> = {};
      if (query.status && Object.values(OrderStatus).includes(query.status as OrderStatus)) {
        where.status = query.status;
      }
      if (query.channel && Object.values(OrderChannel).includes(query.channel as OrderChannel)) {
        where.channel = query.channel;
      }

      const orders = await deps.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          customer: { select: { id: true, fullName: true, category: true } },
          partner: { select: { id: true, displayName: true, referralCode: true } },
          reservations: true,
        },
      });

      return reply.code(200).send({
        orders: orders.map((o) => ({
          ...serializeOrder(o),
          customer: o.customer,
          partner: o.partner,
        })),
      });
    }
  );

  app.post(
    "/api/v1/owner/orders",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_DASHBOARD_VIEW)] },
    async (request, reply) => {
      const orderService =
        deps.orderService ?? (deps.prisma ? new OrderService(deps.prisma) : null);
      if (!orderService) {
        return reply.code(503).send({ error: "Order service unavailable." });
      }
      const parsed = createOwnerOrderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid owner order payload.", issues: parsed.error.issues });
      }
      const headerKey =
        typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"]
          : undefined;
      const idempotencyKey = headerKey ?? parsed.data.idempotencyKey;

      try {
        let resolvedCustomerId = parsed.data.customerId;
        if (!resolvedCustomerId) {
          if (!deps.prisma) {
            return reply.code(400).send({ error: "customerId is required." });
          }
          const normalizedRecipient = normalizeLagoslifeUsername(parsed.data.recipientLagoslifeUsername);
          const existingCustomer = await deps.prisma.customer.findFirst({
            where: { lagoslifeUsername: normalizedRecipient },
            select: { id: true },
          });
          if (existingCustomer) {
            resolvedCustomerId = existingCustomer.id;
          } else {
            const placeholderHash = await hashPassword(crypto.randomBytes(24).toString("hex"));
            const walkInEmail = `walkin+${normalizedRecipient.toLowerCase().replace(/[^a-z0-9._-]/g, "")}.${crypto.randomBytes(3).toString("hex")}@offline.bigola.local`;
            const walkIn = await deps.prisma.$transaction(async (tx) => {
              const u = await tx.user.create({
                data: {
                  email: walkInEmail,
                  passwordHash: placeholderHash,
                  role: UserRole.CUSTOMER,
                  isActive: true,
                },
                select: { id: true },
              });
              return tx.customer.create({
                data: {
                  userId: u.id,
                  fullName: normalizedRecipient,
                  lagoslifeUsername: normalizedRecipient,
                  category: CustomerCategory.CATEGORY_B_BIGOLA,
                },
                select: { id: true },
              });
            });
            resolvedCustomerId = walkIn.id;
          }
        }

        const result = await orderService.createOrder({
          actorUserId: request.auth!.userId,
          channel: OrderChannel.OFFLINE_OWNER,
          customerId: resolvedCustomerId,
          orderType: parsed.data.orderType as OrderType,
          gameAmount: parsed.data.gameAmount ? BigInt(parsed.data.gameAmount) : undefined,
          packageId: parsed.data.packageId,
          recipientLagoslifeUsername: parsed.data.recipientLagoslifeUsername,
          idempotencyKey,
        });

        let finalOrder = result.order;
        if (
          parsed.data.markPrePaid &&
          deps.prisma &&
          finalOrder.status === OrderStatus.AWAITING_PAYMENT
        ) {
          finalOrder = await deps.prisma.order.update({
            where: { id: finalOrder.id },
            data: {
              status: OrderStatus.READY_FOR_FULFILMENT,
              verifiedGrossFiatKobo: finalOrder.fiatAmountKobo,
            },
            include: { reservations: true },
          });
          await deps.audit.record({
            actorUserId: request.auth!.userId,
            actionType: "OWNER_PREPAID_ORDER_RECORDED",
            targetEntity: "ORDER",
            targetId: finalOrder.id,
            afterState: {
              orderNumber: finalOrder.orderNumber,
              recipientLagoslifeUsername: finalOrder.recipientLagoslifeUsername,
              gameAmountRequested: finalOrder.gameAmountRequested.toString(),
            },
            reason: parsed.data.reason?.trim() || "Pre-paid direct owner order",
            ipAddress: request.ip,
          });
        }

        return reply.code(result.idempotentReplay ? 200 : 201).send({
          idempotentReplay: result.idempotentReplay,
          order: serializeOrder(finalOrder),
        });
      } catch (err) {
        if (err instanceof OrderError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/orders/:orderId/cancel",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_DASHBOARD_VIEW)] },
    async (request, reply) => {
      const orderService =
        deps.orderService ?? (deps.prisma ? new OrderService(deps.prisma) : null);
      if (!orderService) {
        return reply.code(503).send({ error: "Order service unavailable." });
      }
      const { orderId } = request.params as { orderId: string };
      const parsed = cancelOwnerOrderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Cancellation reason is required.", issues: parsed.error.issues });
      }
      try {
        const cancelled = await orderService.cancelOrder({
          orderId,
          actorUserId: request.auth!.userId,
          reason: parsed.data.reason,
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

  app.post(
    "/api/v1/owner/orders/expire-stale",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_DASHBOARD_VIEW)] },
    async (request, reply) => {
      const orderService =
        deps.orderService ?? (deps.prisma ? new OrderService(deps.prisma) : null);
      if (!orderService) {
        return reply.code(503).send({ error: "Order service unavailable." });
      }
      const result = await orderService.expireStaleOrders(request.auth!.userId, request.ip);
      return reply.code(200).send(result);
    }
  );

  // --- Phase 5: Partner Verifier Authorization, Dual-Control OPay Accounts & Accountability ---

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

  app.put(
    "/api/v1/owner/partners/:partnerId/verification-permission",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_PARTNER_MANAGE)] },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const { partnerId } = request.params as { partnerId: string };
      const parsed = updatePartnerVerificationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid verification permission payload.", issues: parsed.error.issues });
      }

      const existing = await deps.prisma.partner.findUnique({ where: { id: partnerId } });
      if (!existing) {
        return reply.code(404).send({ error: "Partner not found." });
      }

      const updated = await deps.prisma.partner.update({
        where: { id: partnerId },
        data: { canVerifyPayments: parsed.data.canVerifyPayments },
      });

      await deps.audit.record({
        actorUserId: request.auth!.userId,
        actionType: "PARTNER_VERIFICATION_PERMISSION_UPDATED",
        targetEntity: "partners",
        targetId: partnerId,
        beforeState: { canVerifyPayments: existing.canVerifyPayments },
        afterState: { canVerifyPayments: updated.canVerifyPayments },
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        partner: {
          id: updated.id,
          displayName: updated.displayName,
          canVerifyPayments: updated.canVerifyPayments,
        },
      });
    }
  );

  app.get("/api/v1/owner/bank-accounts", { preHandler: ownerGuard }, async (_request, reply) => {
    const svc = getVerificationService();
    if (!svc) return reply.code(503).send({ error: "Verification service unavailable." });
    const data = await svc.listBankAccounts();
    return reply.code(200).send(data);
  });

  app.post(
    "/api/v1/owner/bank-accounts/propose",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (request, reply) => {
      const svc = getVerificationService();
      if (!svc) return reply.code(503).send({ error: "Verification service unavailable." });
      const parsed = proposeOwnerBankChangeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid bank account proposal.", issues: parsed.error.issues });
      }
      try {
        if (!parsed.data.ownerPartnerId) {
          const account = await svc.setOwnerBankAccount({
            actorUserId: request.auth!.userId,
            actionType: parsed.data.actionType,
            receivingBankAccountId: parsed.data.receivingBankAccountId,
            proposedData: parsed.data.proposedData,
            reason: parsed.data.reason,
            ipAddress: request.ip,
          });
          return reply.code(201).send({ account, direct: true });
        }
        const req = await svc.proposeBankAccountChange({
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          ownerPartnerId: parsed.data.ownerPartnerId,
          actionType: parsed.data.actionType,
          receivingBankAccountId: parsed.data.receivingBankAccountId,
          proposedData: parsed.data.proposedData,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(201).send({ request: req });
      } catch (err) {
        if (err instanceof VerificationError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.put(
    "/api/v1/owner/bank-accounts/:id",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (_request, reply) => {
      return reply.code(403).send({
        code: "DUAL_CONTROL_REQUIRED",
        error:
          "Partner-owned receiving bank accounts cannot be modified unilaterally. Submit a change proposal for Partner confirmation.",
      });
    }
  );

  app.get(
    "/api/v1/owner/financial-accountability",
    { preHandler: ownerGuard },
    async (_request, reply) => {
      const svc = getVerificationService();
      if (!svc) return reply.code(503).send({ error: "Verification service unavailable." });
      const report = await svc.getFinancialAccountability();
      return reply.code(200).send(report);
    }
  );

  app.post(
    "/api/v1/owner/users/:userId/issue-reset-token",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const { userId } = request.params as { userId: string };
      const parsed = z
        .object({ reason: z.string().min(3).max(500) })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "A mandatory reason (min 3 chars) is required." });
      }

      const targetUser = await deps.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, role: true },
      });
      if (!targetUser) {
        return reply.code(404).send({ error: "User not found." });
      }

      const rawToken = generateOpaqueToken(24);
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

      await deps.prisma.$transaction(async (tx) => {
        await tx.accountActionToken.updateMany({
          where: {
            userId: targetUser.id,
            type: AccountTokenType.PASSWORD_RESET,
            usedAt: null,
          },
          data: { usedAt: new Date() },
        });

        await tx.accountActionToken.create({
          data: {
            userId: targetUser.id,
            tokenHash,
            type: AccountTokenType.PASSWORD_RESET,
            issuedById: request.auth!.userId,
            expiresAt,
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: request.auth!.userId,
            actionType: "USER_PASSWORD_RESET_ISSUED",
            targetEntity: "USER",
            targetId: targetUser.id,
            afterState: { targetEmail: targetUser.email, targetRole: targetUser.role, expiresAt: expiresAt.toISOString() },
            reason: parsed.data.reason,
            ipAddress: request.ip ?? null,
          },
        });
      });

      return reply.code(201).send({
        userId: targetUser.id,
        email: targetUser.email,
        resetToken: rawToken,
        expiresAt: expiresAt.toISOString(),
      });
    }
  );

  app.get(
    "/api/v1/owner/customers",
    { preHandler: ownerGuard },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const q = ((request.query as { q?: string })?.q ?? "").trim();

      const customers = await deps.prisma.customer.findMany({
        where: q
          ? {
            OR: [
              { fullName: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { lagoslifeUsername: { contains: q, mode: "insensitive" } },
            ],
          }
          : undefined,
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          attributedPartner: { select: { id: true, displayName: true, referralCode: true } },
          user: { select: { id: true, email: true, isActive: true } },
          _count: { select: { orders: true } },
          orders: {
            orderBy: { createdAt: "desc" },
            take: 3,
            select: {
              id: true,
              orderNumber: true,
              status: true,
              fiatAmountKobo: true,
              gameAmountRequested: true,
              createdAt: true,
            },
          },
        },
      });

      return reply.code(200).send({
        customers: customers.map((c) => ({
          id: c.id,
          userId: c.userId,
          fullName: c.fullName,
          email: c.email,
          phone: c.phone,
          lagoslifeUsername: c.lagoslifeUsername,
          category: c.category,
          attributionSource: c.attributionSource,
          attributedAt: c.attributedAt?.toISOString() ?? null,
          attributedPartner: c.attributedPartner,
          user: c.user,
          orderCount: c._count.orders,
          recentOrders: c.orders.map((o) => ({
            id: o.id,
            orderNumber: o.orderNumber,
            status: o.status,
            fiatAmountKobo: o.fiatAmountKobo.toString(),
            gameAmountRequested: o.gameAmountRequested.toString(),
            createdAt: o.createdAt.toISOString(),
          })),
          createdAt: c.createdAt.toISOString(),
        })),
      });
    }
  );

  // --- Phase 7: Order Operations, Refunds, Discrepancies, Analytics & Filtered Audit Logs ---

  app.get(
    "/api/v1/owner/orders/export",
    { preHandler: ownerGuard },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const q = request.query as { status?: string; format?: string };
      const status =
        q?.status && Object.values(OrderStatus).includes(q.status as OrderStatus)
          ? (q.status as OrderStatus)
          : undefined;
      const orders = await deps.prisma.order.findMany({
        where: status ? { status } : undefined,
        orderBy: { createdAt: "desc" },
        take: 500,
        include: {
          customer: { select: { fullName: true, lagoslifeUsername: true } },
          partner: { select: { displayName: true, referralCode: true } },
        },
      });

      if (q?.format === "csv") {
        const header =
          "orderNumber,status,refundFinancialStatus,channel,customer,partner,requestedAmount,fulfilledAmount,fiatKobo,verifiedKobo,refundedKobo,createdAt";
        const rows = orders.map((o) =>
          [
            o.orderNumber,
            o.status,
            o.refundFinancialStatus,
            o.channel,
            `"${(o.customer.fullName ?? "").replace(/"/g, '""')}"`,
            `"${(o.partner?.displayName ?? "Direct").replace(/"/g, '""')}"`,
            o.gameAmountRequested.toFixed(0),
            o.fulfilledAmount.toFixed(0),
            o.fiatAmountKobo.toString(),
            o.verifiedGrossFiatKobo.toString(),
            o.confirmedRefundedKobo.toString(),
            o.createdAt.toISOString(),
          ].join(",")
        );
        return reply
          .code(200)
          .header("content-type", "text/csv; charset=utf-8")
          .send([header, ...rows].join("\n"));
      }

      return reply.code(200).send({
        orders: orders.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          status: o.status,
          refundFinancialStatus: o.refundFinancialStatus,
          channel: o.channel,
          customerName: o.customer.fullName,
          partnerName: o.partner?.displayName ?? null,
          gameAmountRequested: o.gameAmountRequested.toFixed(0),
          fulfilledAmount: o.fulfilledAmount.toFixed(0),
          fiatAmountKobo: o.fiatAmountKobo.toString(),
          verifiedGrossFiatKobo: o.verifiedGrossFiatKobo.toString(),
          confirmedRefundedKobo: o.confirmedRefundedKobo.toString(),
          createdAt: o.createdAt.toISOString(),
        })),
      });
    }
  );

  app.get(
    "/api/v1/owner/orders/:orderId",
    { preHandler: ownerGuard },
    async (request, reply) => {
      const svc = getOpsSvc();
      if (!svc) return reply.code(503).send({ error: "Operations service unavailable." });
      const { orderId } = request.params as { orderId: string };
      try {
        const order = await svc.getOrderOperationalDetail(orderId);
        const disbSvc = await getDisbSvc();
        const disbursementJobs = disbSvc ? await disbSvc.getOrderDisbursementJobs(orderId) : [];
        return reply.code(200).send({
          order: {
            ...order,
            disbursementJobs,
          },
        });
      } catch (err) {
        if (err instanceof OperationsError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/orders/:orderId/confirm-fulfilment",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_FULFILMENT_CONFIRM)] },
    async (request, reply) => {
      const svc = getOpsSvc();
      if (!svc) return reply.code(503).send({ error: "Operations service unavailable." });
      const { orderId } = request.params as { orderId: string };
      const parsed = z
        .object({
          sourceGameAccountId: z.string().uuid(),
          deliveredAmount: z.string().regex(/^\d+$/),
          externalReference: z.string().min(3).max(120),
          idempotencyKey: z.string().min(3).max(120).optional(),
          notes: z.string().max(500).optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid manual fulfilment payload.", details: parsed.error.flatten() });
      }
      const headerIdem = request.headers["idempotency-key"];
      const idempotencyKey =
        (typeof headerIdem === "string" && headerIdem.trim()) || parsed.data.idempotencyKey;
      if (!idempotencyKey) {
        return reply.code(400).send({ error: "Idempotency-Key header or idempotencyKey field is required." });
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

  app.post(
    "/api/v1/owner/orders/:orderId/refunds",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_REFUND_MANAGE)] },
    async (request, reply) => {
      const svc = getOpsSvc();
      if (!svc) return reply.code(503).send({ error: "Operations service unavailable." });
      const { orderId } = request.params as { orderId: string };
      const parsed = z
        .object({
          scope: z.nativeEnum(RefundScope),
          requestedAmountKobo: z.string().regex(/^\d+$/),
          reason: z.string().min(3).max(500),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid refund request payload.", details: parsed.error.flatten() });
      }
      try {
        const result = await svc.requestRefund({
          orderId,
          actorUserId: request.auth!.userId,
          scope: parsed.data.scope,
          requestedAmountKobo: BigInt(parsed.data.requestedAmountKobo),
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(201).send({
          refundRequest: {
            id: result.request.id,
            orderId: result.request.orderId,
            scope: result.request.scope,
            requestedAmountKobo: result.request.requestedAmountKobo.toString(),
            currentStatus: result.request.currentStatus,
            createdAt: result.request.createdAt.toISOString(),
          },
          event: {
            id: result.event.id,
            eventType: result.event.eventType,
            amountKobo: result.event.amountKobo.toString(),
            reason: result.event.reason,
            createdAt: result.event.createdAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof OperationsError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/orders/:orderId/refunds/:refundId/advance",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_REFUND_MANAGE)] },
    async (request, reply) => {
      const svc = getOpsSvc();
      if (!svc) return reply.code(503).send({ error: "Operations service unavailable." });
      const { orderId, refundId } = request.params as { orderId: string; refundId: string };
      const parsed = z.object({ reason: z.string().min(3).max(500) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Reason is required." });
      }
      try {
        const result = await svc.advanceRefundToPending({
          orderId,
          refundId,
          actorUserId: request.auth!.userId,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({
          refundRequest: {
            id: result.request.id,
            currentStatus: result.request.currentStatus,
          },
        });
      } catch (err) {
        if (err instanceof OperationsError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/orders/:orderId/refunds/:refundId/reject",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_REFUND_MANAGE)] },
    async (request, reply) => {
      const svc = getOpsSvc();
      if (!svc) return reply.code(503).send({ error: "Operations service unavailable." });
      const { orderId, refundId } = request.params as { orderId: string; refundId: string };
      const parsed = z.object({ reason: z.string().min(3).max(500) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Reason is required." });
      }
      try {
        const result = await svc.rejectRefund({
          orderId,
          refundId,
          actorUserId: request.auth!.userId,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({
          refundRequest: {
            id: result.request.id,
            currentStatus: result.request.currentStatus,
          },
        });
      } catch (err) {
        if (err instanceof OperationsError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/orders/:orderId/refunds/:refundId/confirm",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_REFUND_MANAGE)] },
    async (request, reply) => {
      const svc = getOpsSvc();
      if (!svc) return reply.code(503).send({ error: "Operations service unavailable." });
      const { orderId, refundId } = request.params as { orderId: string; refundId: string };
      const parsed = z
        .object({
          confirmedAmountKobo: z.string().regex(/^\d+$/),
          refundReference: z.string().min(3).max(120),
          idempotencyKey: z.string().min(3).max(120).optional(),
          reason: z.string().min(3).max(500),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid refund confirmation payload.", details: parsed.error.flatten() });
      }
      const headerIdem = request.headers["idempotency-key"];
      const idempotencyKey =
        (typeof headerIdem === "string" && headerIdem.trim()) || parsed.data.idempotencyKey;
      if (!idempotencyKey) {
        return reply.code(400).send({ error: "Idempotency-Key header or idempotencyKey field is required." });
      }
      try {
        const result = await svc.confirmRefund({
          orderId,
          refundId,
          actorUserId: request.auth!.userId,
          confirmedAmountKobo: BigInt(parsed.data.confirmedAmountKobo),
          refundReference: parsed.data.refundReference,
          idempotencyKey,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof OperationsError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/owner/ops-admins",
    { preHandler: ownerGuard },
    async (_request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const users = await deps.prisma.user.findMany({
        where: { role: UserRole.OPS_ADMIN },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          isActive: true,
          canConfirmFulfilment: true,
          createdAt: true,
        },
      });
      return reply.code(200).send({ opsAdmins: users });
    }
  );

  app.patch(
    "/api/v1/owner/ops-admins/:userId/fulfilment-permission",
    { preHandler: ownerGuard },
    async (request, reply) => {
      if (!deps.prisma) return reply.code(503).send({ error: "Database unavailable." });
      const { userId } = request.params as { userId: string };
      const parsed = z
        .object({ canConfirmFulfilment: z.boolean(), reason: z.string().min(3).max(500) })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid payload; boolean and reason required." });
      }

      const target = await deps.prisma.user.findUnique({ where: { id: userId } });
      if (!target || target.role !== UserRole.OPS_ADMIN) {
        return reply.code(404).send({ error: "OPS_ADMIN user not found." });
      }

      const updated = await deps.prisma.user.update({
        where: { id: target.id },
        data: { canConfirmFulfilment: parsed.data.canConfirmFulfilment },
        select: { id: true, email: true, role: true, canConfirmFulfilment: true },
      });

      await deps.audit.record({
        actorUserId: request.auth!.userId,
        actionType: "OPS_ADMIN_FULFILMENT_PERMISSION_UPDATED",
        targetEntity: "users",
        targetId: target.id,
        beforeState: { canConfirmFulfilment: target.canConfirmFulfilment },
        afterState: { canConfirmFulfilment: updated.canConfirmFulfilment },
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });

      return reply.code(200).send({ opsAdmin: updated });
    }
  );

  app.get(
    "/api/v1/owner/inventory/discrepancies",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_INVENTORY_MANAGE)] },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const q = request.query as { status?: string };
      const status =
        q?.status &&
          Object.values(InventoryDiscrepancyStatus).includes(q.status as InventoryDiscrepancyStatus)
          ? (q.status as InventoryDiscrepancyStatus)
          : undefined;
      const discrepancies = await svc.listDiscrepancies(status);
      return reply.code(200).send({ discrepancies });
    }
  );

  app.post(
    "/api/v1/owner/inventory/discrepancies/:id/resolve",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_INVENTORY_MANAGE)] },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const { id } = request.params as { id: string };
      const parsed = z
        .object({
          status: z.enum(["ACKNOWLEDGED", "RESOLVED"]),
          resolutionNotes: z.string().min(3).max(500),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid discrepancy resolution payload." });
      }
      try {
        const discrepancy = await svc.resolveDiscrepancy({
          discrepancyId: id,
          actorUserId: request.auth!.userId,
          status: parsed.data.status,
          resolutionNotes: parsed.data.resolutionNotes,
          ipAddress: request.ip,
        });
        return reply.code(200).send({ discrepancy });
      } catch (err) {
        if (err instanceof InventoryError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.patch(
    "/api/v1/owner/inventory/accounts/:id",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_INVENTORY_MANAGE)] },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const { id } = request.params as { id: string };
      const parsed = z
        .object({
          targetReserveAmount: z.string().regex(/^\d+$/).optional(),
          lagoslifeUsername: z.string().min(2).max(60).nullable().optional(),
          healthStatus: z.nativeEnum(GameAccountHealth).optional(),
          reason: z.string().min(3).max(500),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid reserve account update payload." });
      }
      try {
        const account = await svc.updateReserveAccount({
          accountId: id,
          actorUserId: request.auth!.userId,
          targetReserveAmount: parsed.data.targetReserveAmount
            ? BigInt(parsed.data.targetReserveAmount)
            : undefined,
          lagoslifeUsername: parsed.data.lagoslifeUsername,
          healthStatus: parsed.data.healthStatus,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({ account });
      } catch (err) {
        if (err instanceof InventoryError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/owner/inventory/alerts",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_INVENTORY_MANAGE)] },
    async (_request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const data = await svc.checkInventoryAlerts({ notifyOwners: false });
      return reply.code(200).send(data);
    }
  );

  app.post(
    "/api/v1/owner/inventory/check-alerts",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_INVENTORY_MANAGE)] },
    async (_request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const data = await svc.checkInventoryAlerts({ notifyOwners: true });
      return reply.code(200).send(data);
    }
  );

  // =========================================================================
  // STAGE 8A: LagosLife Authentication & 5-Account Session Management
  // =========================================================================
  const connectSlotLoginSchema = z.object({
    username: z.string().min(1).max(120),
    password: z.string().min(1).max(256),
  });

  const completeSlotTwoFactorSchema = z.object({
    challenge: z.string().min(1),
    code: z.string().min(4).max(12),
  });

  const resendSlotTwoFactorSchema = z.object({
    challenge: z.string().min(1),
  });

  const importSlotCookieSchema = z.object({
    cookie: z.string().min(5).max(8192),
    lagoslifeUsername: z.string().min(2).max(60).optional(),
  });

  app.post(
    "/api/v1/owner/inventory/accounts/:slotCode/connect/login",
    {
      config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
      preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ACCOUNT_TOPOLOGY_MANAGE)],
    },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const { slotCode } = request.params as { slotCode: string };
      const parsed = connectSlotLoginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid LagosLife login payload.", details: parsed.error.flatten() });
      }

      try {
        const result = await svc.connectSlotWithCredentials({
          actorUserId: request.auth!.userId,
          slotCode,
          username: parsed.data.username,
          password: parsed.data.password,
          ipAddress: request.ip,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InventoryError || err instanceof LagosLifeError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/inventory/accounts/:slotCode/connect/2fa",
    {
      config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
      preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ACCOUNT_TOPOLOGY_MANAGE)],
    },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const { slotCode } = request.params as { slotCode: string };
      const parsed = completeSlotTwoFactorSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid LagosLife 2FA payload.", details: parsed.error.flatten() });
      }

      try {
        const result = await svc.completeSlotLoginTwoFactor({
          actorUserId: request.auth!.userId,
          slotCode,
          challenge: parsed.data.challenge,
          code: parsed.data.code,
          ipAddress: request.ip,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InventoryError || err instanceof LagosLifeError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/inventory/accounts/:slotCode/connect/2fa/resend",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ACCOUNT_TOPOLOGY_MANAGE)],
    },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const { slotCode } = request.params as { slotCode: string };
      const parsed = resendSlotTwoFactorSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid LagosLife 2FA resend payload.", details: parsed.error.flatten() });
      }

      try {
        const result = await svc.resendSlotLoginTwoFactor({
          slotCode,
          challenge: parsed.data.challenge,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InventoryError || err instanceof LagosLifeError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/inventory/accounts/:slotCode/connect/cookie",
    {
      config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
      preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ACCOUNT_TOPOLOGY_MANAGE)],
    },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const { slotCode } = request.params as { slotCode: string };
      const parsed = importSlotCookieSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid cookie import payload.", details: parsed.error.flatten() });
      }

      try {
        const result = await svc.importSlotCookie({
          actorUserId: request.auth!.userId,
          slotCode,
          cookie: parsed.data.cookie,
          lagoslifeUsername: parsed.data.lagoslifeUsername,
          ipAddress: request.ip,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InventoryError || err instanceof LagosLifeError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.put(
    "/api/v1/owner/inventory/accounts/:slotCode/pin",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_INVENTORY_MANAGE)] },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const { slotCode } = request.params as { slotCode: string };
      const parsed = z
        .object({
          pin: z.string().min(4).max(16),
          reason: z.string().min(3).max(500).optional(),
        })
        .safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Transaction PIN must be 4 to 16 characters." });
      }
      try {
        const result = await svc.setAccountTransactionPin({
          actorUserId: request.auth!.userId,
          slotCode,
          pin: parsed.data.pin,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InventoryError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.delete(
    "/api/v1/owner/inventory/accounts/:slotCode/pin",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_INVENTORY_MANAGE)] },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const { slotCode } = request.params as { slotCode: string };
      const parsed = z
        .object({
          reason: z.string().min(3).max(500).optional(),
        })
        .safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid clear-PIN payload." });
      }
      try {
        const result = await svc.clearAccountTransactionPin({
          actorUserId: request.auth!.userId,
          slotCode,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InventoryError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/inventory/accounts/:slotCode/replace",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_ACCOUNT_TOPOLOGY_MANAGE)] },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const { slotCode } = request.params as { slotCode: string };
      const parsed = z
        .object({
          confirm: z.literal(true),
          reason: z.string().min(3).max(500),
        })
        .safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Explicit confirmation (confirm: true) and audit reason (min 3 chars) are required.",
        });
      }
      try {
        const { AccountTransferCoordinator } = await import("../services/disbursement.js");
        const coordinator = new AccountTransferCoordinator(deps.queues?.redis ?? null);
        const result = await svc.replaceReserveAccount({
          actorUserId: request.auth!.userId,
          slotCode,
          reason: parsed.data.reason,
          isAccountLockedFn: (accountId) => coordinator.isAccountLocked(accountId),
          ipAddress: request.ip,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InventoryError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/inventory/accounts/:slotCode/verify-session",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_INVENTORY_MANAGE)] },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const { slotCode } = request.params as { slotCode: string };

      try {
        const result = await svc.verifySlotSession({
          actorUserId: request.auth!.userId,
          slotCode,
          ipAddress: request.ip,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InventoryError || err instanceof LagosLifeError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/inventory/accounts/:slotCode/sync-live",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_INVENTORY_MANAGE)] },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const { slotCode } = request.params as { slotCode: string };

      try {
        const result = await svc.syncLiveSlotBalance({
          actorUserId: request.auth!.userId,
          slotCode,
          ipAddress: request.ip,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InventoryError || err instanceof LagosLifeError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/inventory/sync-all-live",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_INVENTORY_MANAGE)] },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });

      try {
        const result = await svc.syncAllLiveBalances({
          actorUserId: request.auth!.userId,
          ipAddress: request.ip,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InventoryError || err instanceof LagosLifeError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/owner/inventory/resolve-player",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_INVENTORY_MANAGE)] },
    async (request, reply) => {
      const svc = getInvSvc();
      if (!svc) return reply.code(503).send({ error: "Inventory service unavailable." });
      const queryObj = (request.query as { q?: string; username?: string }) ?? {};
      const q = String(queryObj.q ?? queryObj.username ?? "").trim();
      if (!q) {
        return reply.code(400).send({ error: "Query parameter 'q' or 'username' is required." });
      }

      try {
        const result = await svc.resolvePlayerUsername(q);
        return reply.code(200).send({
          ...result,
          resolved: true,
          player: result,
        });
      } catch (err) {
        if (err instanceof InventoryError || err instanceof LagosLifeError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/owner/partners/:partnerId/performance",
    { preHandler: ownerGuard },
    async (request, reply) => {
      const svc = getAnalyticsSvc();
      if (!svc || !deps.prisma) return reply.code(503).send({ error: "Analytics service unavailable." });
      const { partnerId } = request.params as { partnerId: string };
      const partner = await deps.prisma.partner.findUnique({
        where: { id: partnerId },
        select: { id: true, userId: true, displayName: true, referralCode: true, status: true },
      });
      if (!partner) return reply.code(404).send({ error: "Partner not found." });
      const windowDays = Math.min(Math.max(Number((request.query as { days?: string })?.days ?? 30) || 30, 1), 365);
      const [performance, activity] = await Promise.all([
        svc.getPartnerPerformance(partner.id, windowDays),
        svc.getPartnerActivity(partner.id, partner.userId),
      ]);
      return reply.code(200).send({ partner, performance, activity });
    }
  );

  app.get(
    "/api/v1/owner/analytics",
    { preHandler: ownerGuard },
    async (request, reply) => {
      const svc = getAnalyticsSvc();
      if (!svc) return reply.code(503).send({ error: "Analytics service unavailable." });
      const q = request.query as { from?: string; to?: string };
      const from = q?.from ? new Date(q.from) : undefined;
      const to = q?.to ? new Date(q.to) : undefined;
      const analytics = await svc.getOwnerAnalytics({
        from: from && !Number.isNaN(from.getTime()) ? from : undefined,
        to: to && !Number.isNaN(to.getTime()) ? to : undefined,
      });
      return reply.code(200).send(analytics);
    }
  );

  app.get(
    "/api/v1/owner/audit-logs",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_AUDIT_LOG_READ)] },
    async (request, reply) => {
      const q = request.query as {
        actionType?: string;
        targetEntity?: string;
        actorUserId?: string;
        search?: string;
        limit?: string;
      };
      const limit = Math.min(Math.max(Number(q?.limit ?? 100) || 100, 1), 200);
      if (!deps.prisma) {
        const recent = await deps.audit.listRecent(limit);
        return reply.code(200).send({ logs: recent });
      }
      const actionType = (q?.actionType ?? "").trim();
      const targetEntity = (q?.targetEntity ?? "").trim();
      const actorUserId = (q?.actorUserId ?? "").trim();
      const search = (q?.search ?? "").trim();

      const logs = await deps.prisma.auditLog.findMany({
        where: {
          ...(actionType ? { actionType: { contains: actionType, mode: "insensitive" } } : {}),
          ...(targetEntity ? { targetEntity: { contains: targetEntity, mode: "insensitive" } } : {}),
          ...(actorUserId ? { actorUserId } : {}),
          ...(search
            ? {
              OR: [
                { reason: { contains: search, mode: "insensitive" } },
                { actionType: { contains: search, mode: "insensitive" } },
                { targetEntity: { contains: search, mode: "insensitive" } },
              ],
            }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: {
          actor: { select: { id: true, email: true, role: true } },
        },
      });

      return reply.code(200).send({
        logs: logs.map((l) => ({
          id: l.id,
          actionType: l.actionType,
          targetEntity: l.targetEntity,
          targetId: l.targetId,
          beforeState: l.beforeState,
          afterState: l.afterState,
          reason: l.reason,
          ipAddress: l.ipAddress,
          actor: l.actor,
          createdAt: l.createdAt.toISOString(),
        })),
      });
    }
  );

  // --- Stage 8B: Multi-Account LagosLife Disbursement Engine ---

  app.get(
    "/api/v1/owner/orders/:orderId/disbursements",
    { preHandler: ownerGuard },
    async (request, reply) => {
      const disbSvc = await getDisbSvc();
      if (!disbSvc) {
        return reply.code(503).send({ error: "Disbursement service unavailable." });
      }
      const { orderId } = request.params as { orderId: string };
      const jobs = await disbSvc.getOrderDisbursementJobs(orderId);
      return reply.code(200).send({
        disbursementEnabled: disbSvc.isDisbursementEnabled(),
        jobs,
      });
    }
  );

  app.post(
    "/api/v1/owner/orders/:orderId/confirm-and-deliver",
    {
      preHandler: [
        deps.authenticate,
        deps.requirePermission(Permission.ORDER_FULFILMENT_CONFIRM),
      ],
    },
    async (request, reply) => {
      if (!deps.prisma) {
        return reply.code(503).send({ error: "Database unavailable." });
      }
      const disbSvc = await getDisbSvc();
      if (!disbSvc) {
        return reply.code(503).send({ error: "Disbursement service unavailable." });
      }
      const confirmSchema = z.object({
        receivingBankAccountId: z.string().uuid().optional(),
        bankCreditReference: z.string().min(3).max(120),
        bankCreditAmountKobo: z.string().regex(/^\d+$/).optional(),
        allowExcessResolution: z.boolean().optional(),
        reason: z.string().min(3).max(500).optional(),
      });
      const parsed = confirmSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid confirmation payload. A valid bank/OPay transaction reference is required.",
          issues: parsed.error.issues,
        });
      }

      const { orderId } = request.params as { orderId: string };
      const order = await deps.prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, fiatAmountKobo: true, orderNumber: true },
      });
      if (!order) {
        return reply.code(404).send({ error: "Order not found." });
      }

      const alreadyVerifiedStatuses: string[] = [
        "READY_FOR_FULFILMENT",
        "QUEUED",
        "DISBURSING",
        "PARTIALLY_FULFILLED",
        "COMPLETED",
      ];
      if (alreadyVerifiedStatuses.includes(order.status)) {
        const existingJobs = await disbSvc.getOrderDisbursementJobs(orderId);
        if (order.status === "READY_FOR_FULFILMENT" && existingJobs.length === 0) {
          const job = await disbSvc.authorizeDisbursementJob({
            orderId,
            actorUserId: request.auth!.userId,
            actorRole: request.auth!.role,
            authorizationNote:
              parsed.data.reason?.trim() || "Owner confirmed payment and started automated delivery",
            ipAddress: request.ip,
          });
          return reply.code(200).send({
            idempotent: true,
            orderStatus: "QUEUED",
            disbursementEnabled: disbSvc.isDisbursementEnabled(),
            job,
          });
        }
        return reply.code(200).send({
          idempotent: true,
          orderStatus: order.status,
          disbursementEnabled: disbSvc.isDisbursementEnabled(),
          job: existingJobs[0] ?? null,
        });
      }

      let receivingBankAccountId = parsed.data.receivingBankAccountId;
      if (!receivingBankAccountId) {
        const defaultAccount = await deps.prisma.receivingBankAccount.findFirst({
          where: { isActive: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
          select: { id: true },
        });
        if (!defaultAccount) {
          return reply.code(409).send({
            code: "NO_ACTIVE_RECEIVING_ACCOUNT",
            error: "No active receiving bank account is configured.",
          });
        }
        receivingBankAccountId = defaultAccount.id;
      }

      const { CommissionService } = await import("../services/commission.js");
      const { NotificationService } = await import("../services/notification.js");
      const { VerificationError, VerificationService } = await import("../services/verification.js");
      const { DisbursementError } = await import("../services/disbursement.js");

      const verificationSvc = new VerificationService(
        deps.prisma,
        new CommissionService(deps.prisma),
        new NotificationService(deps.prisma)
      );

      try {
        await verificationSvc.assertAuthorizedVerifier(request.auth!.userId, request.auth!.role);
        const reasonText =
          parsed.data.reason && parsed.data.reason.trim().length >= 10
            ? parsed.data.reason.trim()
            : `Owner confirmed payment (${parsed.data.bankCreditReference.trim()}) and started delivery`;

        const verificationResult = await verificationSvc.approveOrderPayment({
          orderId,
          verifierUserId: request.auth!.userId,
          verifierRole: request.auth!.role,
          receivingBankAccountId,
          manualVerificationException: true,
          allowAwaitingPayment: true,
          bankCreditConfirmed: true,
          bankCreditReference: parsed.data.bankCreditReference.trim(),
          bankCreditAmountKobo: parsed.data.bankCreditAmountKobo
            ? BigInt(parsed.data.bankCreditAmountKobo)
            : order.fiatAmountKobo,
          allowExcessResolution: parsed.data.allowExcessResolution,
          reason: reasonText,
          ipAddress: request.ip,
        });

        if (verificationResult.order.status !== "READY_FOR_FULFILMENT") {
          return reply.code(200).send({
            idempotent: false,
            decisionId: verificationResult.decision.id,
            orderStatus: verificationResult.order.status,
            paymentExceptionType: verificationResult.order.paymentExceptionType,
            disbursementEnabled: disbSvc.isDisbursementEnabled(),
            job: null,
          });
        }

        const job = await disbSvc.authorizeDisbursementJob({
          orderId,
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          authorizationNote: reasonText,
          ipAddress: request.ip,
        });

        return reply.code(200).send({
          idempotent: false,
          decisionId: verificationResult.decision.id,
          orderStatus: "QUEUED",
          disbursementEnabled: disbSvc.isDisbursementEnabled(),
          job,
        });
      } catch (err) {
        if (err instanceof VerificationError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        if (err instanceof DisbursementError) {
          return reply.code(err.statusCode).send({ code: err.code, error: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/orders/:orderId/disbursements/authorize",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_FULFILMENT_CONFIRM)] },
    async (request, reply) => {
      const disbSvc = await getDisbSvc();
      if (!disbSvc) {
        return reply.code(503).send({ error: "Disbursement service unavailable." });
      }
      const { orderId } = request.params as { orderId: string };
      const parsed = authorizeDisbursementSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid disbursement authorization payload.",
          details: parsed.error.flatten(),
        });
      }
      try {
        const job = await disbSvc.authorizeDisbursementJob({
          orderId,
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          allocations: parsed.data.allocations?.map((a) => ({
            slotCode: a.slotCode,
            gameAccountId: a.gameAccountId,
            amount: BigInt(a.amount),
          })),
          authorizationNote: parsed.data.authorizationNote,
          ipAddress: request.ip,
        });
        return reply.code(201).send({
          disbursementEnabled: disbSvc.isDisbursementEnabled(),
          job,
        });
      } catch (err) {
        const { DisbursementError } = await import("../services/disbursement.js");
        if (err instanceof DisbursementError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/owner/operations/pipelines",
    { preHandler: ownerGuard },
    async (_request, reply) => {
      const disbSvc = await getDisbSvc();
      if (!disbSvc) {
        return reply.code(503).send({ error: "Disbursement service unavailable." });
      }
      const [overview, queueStats, workerHeartbeat, workerControl] = await Promise.all([
        disbSvc.getOperationalPipelineOverview(),
        deps.queues
          ? deps.queues.getDisbursementQueueStats()
          : Promise.resolve({
              connected: false,
              waiting: 0,
              active: 0,
              delayed: 0,
              failed: 0,
              completed: 0,
            }),
        deps.queues
          ? deps.queues.getWorkerHeartbeat()
          : Promise.resolve({
              alive: false,
              lastHeartbeatAt: null,
              service: null,
              disbursementEnabled: null,
              intakePaused: null,
              permittedConcurrency: null,
            }),
        deps.queues
          ? deps.queues.getWorkerControl()
          : Promise.resolve({
              intakePaused: false,
              permittedConcurrency: 5,
              updatedAt: null,
              updatedBy: null,
              reason: null,
            }),
      ]);
      return reply.code(200).send({
        ...overview,
        queueStats,
        workerHeartbeat,
        workerControl,
      });
    }
  );

  app.post(
    "/api/v1/owner/worker/control",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.OWNER_SETTINGS_MANAGE)] },
    async (request, reply) => {
      if (!deps.queues) {
        return reply.code(503).send({ error: "Redis queue infrastructure is unavailable." });
      }
      const parsed = workerControlSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid worker control payload.", issues: parsed.error.issues });
      }

      const before = await deps.queues.getWorkerControl();
      let patch: {
        intakePaused?: boolean;
        permittedConcurrency?: number;
        updatedBy: string;
        reason: string;
      } = {
        updatedBy: request.auth!.userId,
        reason: parsed.data.reason,
      };

      if (parsed.data.action === "PAUSE_INTAKE") {
        patch.intakePaused = true;
      } else if (parsed.data.action === "RESUME_INTAKE") {
        patch.intakePaused = false;
      } else if (parsed.data.action === "SET_CONCURRENCY") {
        if (!parsed.data.permittedConcurrency) {
          return reply
            .code(400)
            .send({ error: "permittedConcurrency (1..5) is required for SET_CONCURRENCY." });
        }
        patch.permittedConcurrency = parsed.data.permittedConcurrency;
      }

      const workerControl = await deps.queues.setWorkerControl(patch);
      const workerHeartbeat = await deps.queues.getWorkerHeartbeat();

      await deps.audit.record({
        actorUserId: request.auth!.userId,
        actionType: "WORKER_CONTROL_UPDATED",
        targetEntity: "worker_control",
        targetId: deps.queues.prefix,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: workerControl as unknown as Record<string, unknown>,
        reason: parsed.data.reason,
        ipAddress: request.ip,
      });

      const appliedNote = workerHeartbeat.alive
        ? "Control state saved to Redis. The active Windows worker will apply it within 15 seconds on its next heartbeat/job cycle."
        : "Control state saved to Redis, but the Windows worker is currently OFFLINE. Start it locally with `node --env-file=.env.worker apps/api/dist/worker.js` to process jobs.";

      return reply.code(200).send({
        workerControl,
        workerHeartbeat,
        appliedNote,
      });
    }
  );

  app.get(
    "/api/v1/owner/disbursements/:jobId",
    { preHandler: ownerGuard },
    async (request, reply) => {
      const disbSvc = await getDisbSvc();
      if (!disbSvc) {
        return reply.code(503).send({ error: "Disbursement service unavailable." });
      }
      const { jobId } = request.params as { jobId: string };
      try {
        const job = await disbSvc.getJobDetail(jobId);
        return reply.code(200).send({
          disbursementEnabled: disbSvc.isDisbursementEnabled(),
          job,
        });
      } catch (err) {
        const { DisbursementError } = await import("../services/disbursement.js");
        if (err instanceof DisbursementError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/disbursements/:jobId/execute",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_FULFILMENT_CONFIRM)] },
    async (request, reply) => {
      const disbSvc = await getDisbSvc();
      if (!disbSvc) {
        return reply.code(503).send({ error: "Disbursement service unavailable." });
      }
      const { jobId } = request.params as { jobId: string };
      const parsed = executeDisbursementSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid disbursement execution payload.",
          details: parsed.error.flatten(),
        });
      }
      try {
        if (deps.queues?.disbursementQueue && parsed.data.mode !== "sync") {
          const { job, alreadyCompleted } = await disbSvc.prepareJobForQueuedExecution({
            jobId,
            actorUserId: request.auth!.userId,
            actorRole: request.auth!.role,
          });
          if (!alreadyCompleted) {
            const bullId = `disb_exec_${jobId}`;
            const existing = await deps.queues.disbursementQueue.getJob(bullId);
            if (existing) {
              const state = await existing.getState().catch(() => "unknown");
              if (state === "completed" || state === "failed") {
                await existing.remove().catch(() => undefined);
              }
            }
            await deps.queues.disbursementQueue.add(
              "process-disbursement-job",
              {
                jobId,
                actorUserId: request.auth!.userId,
              },
              {
                jobId: bullId,
                attempts: 1, // Critical: never auto-retry uncertain transfers
              }
            );
          }
          return reply.code(200).send({
            queued: !alreadyCompleted,
            disbursementEnabled: disbSvc.isDisbursementEnabled(),
            job,
          });
        }

        const job = await disbSvc.executeJob({
          jobId,
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          maxChunksToProcess: parsed.data.maxChunksToProcess,
          waitForCooldown: parsed.data.waitForCooldown,
          pinByAccountId: parsed.data.pinByAccountId,
          ipAddress: request.ip,
        });
        return reply.code(200).send({
          queued: false,
          disbursementEnabled: disbSvc.isDisbursementEnabled(),
          job,
        });
      } catch (err) {
        const { DisbursementError } = await import("../services/disbursement.js");
        if (err instanceof DisbursementError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/disbursements/:jobId/pause",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_FULFILMENT_CONFIRM)] },
    async (request, reply) => {
      const disbSvc = await getDisbSvc();
      if (!disbSvc) {
        return reply.code(503).send({ error: "Disbursement service unavailable." });
      }
      const { jobId } = request.params as { jobId: string };
      const parsed = pauseOrResumeDisbursementSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid pause payload." });
      }
      try {
        const job = await disbSvc.pauseJob({
          jobId,
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({ job });
      } catch (err) {
        const { DisbursementError } = await import("../services/disbursement.js");
        if (err instanceof DisbursementError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/disbursements/:jobId/resume",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_FULFILMENT_CONFIRM)] },
    async (request, reply) => {
      const disbSvc = await getDisbSvc();
      if (!disbSvc) {
        return reply.code(503).send({ error: "Disbursement service unavailable." });
      }
      const { jobId } = request.params as { jobId: string };
      const parsed = z
        .object({
          reason: z.string().min(3).max(500).optional(),
          twoFactorCode: z.string().min(4).max(16).optional(),
          slotCode: z.string().min(2).max(40).optional(),
        })
        .safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid resume payload." });
      }
      try {
        const job = await disbSvc.resumeJob({
          jobId,
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          reason: parsed.data.reason,
          twoFactorCode: parsed.data.twoFactorCode,
          slotCode: parsed.data.slotCode,
          ipAddress: request.ip,
        });
        return reply.code(200).send({ job });
      } catch (err) {
        const { DisbursementError } = await import("../services/disbursement.js");
        if (err instanceof DisbursementError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/disbursements/:jobId/cancel",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_FULFILMENT_CONFIRM)] },
    async (request, reply) => {
      const disbSvc = await getDisbSvc();
      if (!disbSvc) {
        return reply.code(503).send({ error: "Disbursement service unavailable." });
      }
      const { jobId } = request.params as { jobId: string };
      const parsed = cancelDisbursementSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Cancellation reason is required." });
      }
      try {
        const job = await disbSvc.cancelJob({
          jobId,
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          reason: parsed.data.reason,
          ipAddress: request.ip,
        });
        return reply.code(200).send({ job });
      } catch (err) {
        const { DisbursementError } = await import("../services/disbursement.js");
        if (err instanceof DisbursementError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/owner/disbursements/:jobId/chunks/:chunkId/resolve",
    { preHandler: [deps.authenticate, deps.requirePermission(Permission.ORDER_FULFILMENT_CONFIRM)] },
    async (request, reply) => {
      const disbSvc = await getDisbSvc();
      if (!disbSvc) {
        return reply.code(503).send({ error: "Disbursement service unavailable." });
      }
      const { jobId, chunkId } = request.params as { jobId: string; chunkId: string };
      const parsed = resolveAmbiguousChunkSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid ambiguous chunk resolution payload.",
          details: parsed.error.flatten(),
        });
      }
      try {
        const job = await disbSvc.resolveAmbiguousChunk({
          jobId,
          chunkId,
          actorUserId: request.auth!.userId,
          actorRole: request.auth!.role,
          outcome: parsed.data.outcome,
          notes: parsed.data.notes,
          ipAddress: request.ip,
        });
        return reply.code(200).send({ job });
      } catch (err) {
        const { DisbursementError } = await import("../services/disbursement.js");
        if (err instanceof DisbursementError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
  );
}
