import crypto from "node:crypto";
import {
  CustomerCategory,
  GameAccountHealth,
  GameAccountRole,
  InventoryEntryType,
  InventoryReservationStatus,
  OrderChannel,
  OrderStatus,
  OrderType,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  calculateBulkOrderFiatKobo,
  DEFAULT_BULK_MIN_GAME_AMOUNT,
  DEFAULT_BULK_PRICE_KOBO_PER_TRILLION,
  DEFAULT_MAX_ACTIVE_UNPAID_ORDERS_PER_CUSTOMER,
  DEFAULT_MAX_RESERVED_GAME_AMOUNT_PER_CUSTOMER,
  DEFAULT_ORDER_EXPIRY_MINUTES,
  isInventoryStale,
  normalizeLagoslifeUsername,
  type RetailPackageConfig,
} from "@bigola/shared";
import { getInventoryMaxAgeMinutes } from "./inventory.js";

export function serializeOrder(order: {
  id: string;
  orderNumber: string;
  paymentReference: string;
  channel: OrderChannel;
  orderType: OrderType;
  customerId: string;
  customerCategory: CustomerCategory;
  partnerId: string | null;
  recipientLagoslifeUsername: string;
  gameAmountRequested: Prisma.Decimal;
  gameAmountDelivered: Prisma.Decimal;
  fulfilledAmount?: Prisma.Decimal;
  fiatAmountKobo: bigint;
  verifiedGrossFiatKobo?: bigint;
  confirmedRefundedKobo?: bigint;
  pricingSnapshot: Prisma.JsonValue;
  status: OrderStatus;
  paymentExceptionType?: string;
  refundFinancialStatus?: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  reservations?: Array<{
    id: string;
    gameAccountId: string;
    amount: Prisma.Decimal;
    status: InventoryReservationStatus;
    expiresAt: Date | null;
  }>;
}) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    paymentReference: order.paymentReference,
    channel: order.channel,
    orderType: order.orderType,
    customerId: order.customerId,
    customerCategory: order.customerCategory,
    partnerId: order.partnerId,
    recipientLagoslifeUsername: order.recipientLagoslifeUsername,
    gameAmountRequested: order.gameAmountRequested.toFixed(0),
    gameAmountDelivered: order.gameAmountDelivered.toFixed(0),
    fulfilledAmount: order.fulfilledAmount
      ? order.fulfilledAmount.toFixed(0)
      : order.gameAmountDelivered.toFixed(0),
    fiatAmountKobo: order.fiatAmountKobo.toString(),
    verifiedGrossFiatKobo: (order.verifiedGrossFiatKobo ?? 0n).toString(),
    confirmedRefundedKobo: (order.confirmedRefundedKobo ?? 0n).toString(),
    pricingSnapshot: order.pricingSnapshot,
    status: order.status,
    paymentExceptionType: order.paymentExceptionType ?? "NONE",
    refundFinancialStatus: order.refundFinancialStatus ?? "NONE",
    expiresAt: order.expiresAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    ...(order.reservations
      ? {
          reservations: order.reservations.map((r) => ({
            id: r.id,
            gameAccountId: r.gameAccountId,
            amount: r.amount.toFixed(0),
            status: r.status,
            expiresAt: r.expiresAt?.toISOString() ?? null,
          })),
        }
      : {}),
  };
}

export class OrderError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "OrderError";
  }
}

interface LockedGameAccount {
  id: string;
  slot_code: string;
  account_role: GameAccountRole;
  last_known_balance: string;
  reserved_for_orders: string;
  health_status: GameAccountHealth;
  last_synced_at: Date | null;
}

function parseBigIntString(raw: unknown, fallback: bigint): bigint {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return BigInt(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return BigInt(raw.trim());
  return fallback;
}

function parseDecimalInteger(raw: string): bigint {
  return BigInt(raw.split(".")[0] ?? "0");
}

function generateOrderNumber(): string {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randPart = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `ORD-${datePart}-${randPart}`;
}

function generatePaymentReference(): string {
  const randPart = crypto.randomBytes(5).toString("hex").toUpperCase();
  return `BGL-${randPart}`;
}

export function hashOrderIdempotencyPayload(payload: {
  actorUserId: string;
  channel: OrderChannel;
  customerId: string;
  orderType: OrderType;
  gameAmount: string | null;
  packageId: string | null;
  recipientLagoslifeUsername: string;
}): string {
  const canonical = JSON.stringify({
    actorUserId: payload.actorUserId,
    channel: payload.channel,
    customerId: payload.customerId,
    orderType: payload.orderType,
    gameAmount: payload.gameAmount,
    packageId: payload.packageId,
    recipientLagoslifeUsername: normalizeLagoslifeUsername(payload.recipientLagoslifeUsername),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export class OrderService {
  constructor(private readonly prisma: PrismaClient) {}

  async getPolicies(db: Pick<PrismaClient, "platformSetting"> | Prisma.TransactionClient = this.prisma) {
    const settings = await db.platformSetting.findMany({
      where: {
        key: {
          in: [
            "bulk_pricing",
            "regular_pricing",
            "order_expiry_policy",
            "order_hoarding_policy",
            "inventory_freshness_policy",
          ],
        },
      },
    });
    const byKey = new Map(settings.map((s) => [s.key, s.value]));
    const bulkSetting = byKey.has("bulk_pricing") ? { value: byKey.get("bulk_pricing") } : null;
    const retailSetting = byKey.has("regular_pricing") ? { value: byKey.get("regular_pricing") } : null;
    const expirySetting = byKey.has("order_expiry_policy") ? { value: byKey.get("order_expiry_policy") } : null;
    const hoardingSetting = byKey.has("order_hoarding_policy") ? { value: byKey.get("order_hoarding_policy") } : null;
    const freshnessVal = byKey.get("inventory_freshness_policy") as { maxAgeMinutes?: unknown } | undefined;
    const parsedMaxAge = Number(freshnessVal?.maxAgeMinutes);
    const maxAgeMinutes =
      Number.isFinite(parsedMaxAge) && parsedMaxAge > 0
        ? Math.floor(parsedMaxAge)
        : 60;

    const bulkVal = (bulkSetting?.value ?? {}) as Record<string, unknown>;
    const bulkPriceKoboPerTrillion = parseBigIntString(
      bulkVal.priceKoboPerTrillion,
      DEFAULT_BULK_PRICE_KOBO_PER_TRILLION
    );
    const minBulkGameAmount = parseBigIntString(
      bulkVal.minBulkGameAmount,
      DEFAULT_BULK_MIN_GAME_AMOUNT
    );
    const bulkEnabled = bulkVal.enabled !== false;

    const retailVal = (retailSetting?.value ?? {}) as {
      status?: string;
      packages?: RetailPackageConfig[];
    };
    const retailStatus = retailVal.status === "CONFIGURED" ? "CONFIGURED" : "UNCONFIGURED";
    const retailPackages = Array.isArray(retailVal.packages) ? retailVal.packages : [];

    const expiryVal = (expirySetting?.value ?? {}) as {
      status?: string;
      unpaidExpiryMinutes?: unknown;
    };
    let unpaidExpiryMinutes: number | null = DEFAULT_ORDER_EXPIRY_MINUTES;
    if (expiryVal.status === "CONFIGURED") {
      if (expiryVal.unpaidExpiryMinutes === null) {
        unpaidExpiryMinutes = null;
      } else {
        const parsed = Number(expiryVal.unpaidExpiryMinutes);
        unpaidExpiryMinutes =
          Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_ORDER_EXPIRY_MINUTES;
      }
    }

    const hoardingVal = (hoardingSetting?.value ?? {}) as Record<string, unknown>;
    const maxActiveParsed = Number(hoardingVal.maxActiveUnpaidOrdersPerCustomer);
    const maxActiveUnpaidOrdersPerCustomer =
      Number.isFinite(maxActiveParsed) && maxActiveParsed > 0
        ? Math.floor(maxActiveParsed)
        : DEFAULT_MAX_ACTIVE_UNPAID_ORDERS_PER_CUSTOMER;
    const maxReservedGameAmountPerCustomer = parseBigIntString(
      hoardingVal.maxReservedGameAmountPerCustomer,
      DEFAULT_MAX_RESERVED_GAME_AMOUNT_PER_CUSTOMER
    );

    return {
      bulkPricing: {
        priceKoboPerTrillion: bulkPriceKoboPerTrillion,
        minBulkGameAmount,
        enabled: bulkEnabled,
      },
      retailPricing: {
        status: retailStatus as "UNCONFIGURED" | "CONFIGURED",
        packages: retailPackages,
      },
      expiryPolicy: {
        unpaidExpiryMinutes,
      },
      freshnessPolicy: {
        maxAgeMinutes,
      },
      hoardingPolicy: {
        maxActiveUnpaidOrdersPerCustomer,
        maxReservedGameAmountPerCustomer,
      },
    };
  }

  async getCatalogPricing(now: Date = new Date()) {
    const [policies, accounts] = await Promise.all([
      this.getPolicies(),
      this.prisma.gameAccount.findMany({ orderBy: { slotCode: "asc" } }),
    ]);

    let totalReservableAvailable = 0n;
    let activeFreshSlotCount = 0;
    let staleSlotCount = 0;

    for (const acc of accounts) {
      const stale = isInventoryStale(
        acc.lastSyncedAt,
        policies.freshnessPolicy.maxAgeMinutes,
        now
      );
      if (stale) {
        staleSlotCount++;
        continue;
      }
      if (acc.healthStatus !== GameAccountHealth.ACTIVE) {
        continue;
      }
      const observed = BigInt(acc.lastKnownBalance.toFixed(0));
      const reserved = BigInt(acc.reservedForOrders.toFixed(0));
      if (observed > reserved) {
        totalReservableAvailable += observed - reserved;
        activeFreshSlotCount++;
      }
    }

    const bulkPayload = {
      priceKoboPerTrillion: policies.bulkPricing.priceKoboPerTrillion.toString(),
      minBulkGameAmount: policies.bulkPricing.minBulkGameAmount.toString(),
      enabled: policies.bulkPricing.enabled,
    };

    return {
      bulk: bulkPayload,
      bulkPricing: bulkPayload,
      retail: policies.retailPricing,
      retailPricing: policies.retailPricing,
      unpaidExpiryMinutes: policies.expiryPolicy.unpaidExpiryMinutes,
      inventoryMaxAgeMinutes: policies.freshnessPolicy.maxAgeMinutes,
      hoardingLimits: {
        maxActiveUnpaidOrdersPerCustomer: policies.hoardingPolicy.maxActiveUnpaidOrdersPerCustomer,
        maxReservedGameAmountPerCustomer:
          policies.hoardingPolicy.maxReservedGameAmountPerCustomer.toString(),
      },
      availability: {
        totalReservableAvailable: totalReservableAvailable.toString(),
        reservableAvailable: totalReservableAvailable.toString(),
        activeFreshSlotCount,
        staleSlotCount,
        isFresh: activeFreshSlotCount > 0,
        maxAgeMinutes: policies.freshnessPolicy.maxAgeMinutes,
      },
    };
  }

  /**
   * Releases expired AWAITING_PAYMENT orders inside an existing transaction where
   * game_accounts are already locked in slot_code ASC order.
   */
  private async releaseExpiredOrdersWithLockedAccounts(
    tx: Prisma.TransactionClient,
    lockedAccounts: LockedGameAccount[],
    now: Date,
    actorUserId?: string
  ): Promise<number> {
    const expiredOrders = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM orders
      WHERE status IN ('AWAITING_PAYMENT', 'PAYMENT_EXCEPTION_REVIEW')
        AND expires_at IS NOT NULL
        AND expires_at <= ${now}
      ORDER BY id ASC
      FOR UPDATE
    `;

    if (expiredOrders.length === 0) {
      return 0;
    }

    const accountMap = new Map(lockedAccounts.map((a) => [a.id, a]));

    for (const { id: orderId } of expiredOrders) {
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.EXPIRED },
      });

      const activeReservations = await tx.inventoryReservation.findMany({
        where: { orderId, status: InventoryReservationStatus.ACTIVE },
      });

      for (const res of activeReservations) {
        const resAmount = BigInt(res.amount.toFixed(0));
        await tx.inventoryReservation.update({
          where: { id: res.id },
          data: {
            status: InventoryReservationStatus.EXPIRED,
            releasedAt: now,
            releaseReason: "UNPAID_ORDER_EXPIRED",
          },
        });

        const acc = accountMap.get(res.gameAccountId);
        if (acc) {
          const observed = parseDecimalInteger(acc.last_known_balance);
          const prevReserved = parseDecimalInteger(acc.reserved_for_orders);
          const nextReserved = prevReserved > resAmount ? prevReserved - resAmount : 0n;
          acc.reserved_for_orders = nextReserved.toString();

          await tx.gameAccount.update({
            where: { id: acc.id },
            data: { reservedForOrders: nextReserved.toString() },
          });

          const availableAfter = observed > nextReserved ? observed - nextReserved : 0n;
          await tx.inventoryLedger.create({
            data: {
              gameAccountId: acc.id,
              orderId,
              entryType: InventoryEntryType.ORDER_RELEASE,
              deltaAmount: resAmount.toString(),
              balanceAfter: availableAfter.toString(),
              createdById: actorUserId,
              notes: "Released inventory reservation upon unpaid order expiry.",
            },
          });
        }
      }
    }

    return expiredOrders.length;
  }

  async expireStaleOrders(actorUserId?: string, ipAddress?: string) {
    const now = new Date();
    const expiredCount = await this.prisma.$transaction(async (tx) => {
      const lockedAccounts = await tx.$queryRaw<LockedGameAccount[]>`
        SELECT id, slot_code, account_role, last_known_balance::text, reserved_for_orders::text, health_status, last_synced_at
        FROM game_accounts
        ORDER BY slot_code ASC
        FOR UPDATE
      `;
      const count = await this.releaseExpiredOrdersWithLockedAccounts(
        tx,
        lockedAccounts,
        now,
        actorUserId
      );

      if (actorUserId) {
        await tx.auditLog.create({
          data: {
            actorUserId,
            actionType: "ORDER_EXPIRY_SWEEP",
            targetEntity: "orders",
            afterState: { expiredCount: count, sweptAt: now.toISOString() },
            ipAddress,
          },
        });
      }
      return count;
    }, { maxWait: 15000, timeout: 30000 });

    return { expiredCount, sweptAt: now.toISOString() };
  }

  async createOrder(input: {
    actorUserId: string;
    channel: OrderChannel;
    customerId: string;
    orderType: OrderType;
    gameAmount?: bigint;
    packageId?: string;
    recipientLagoslifeUsername: string;
    idempotencyKey?: string;
  }) {
    const normalizedRecipient = normalizeLagoslifeUsername(input.recipientLagoslifeUsername);
    if (normalizedRecipient.length < 2) {
      throw new OrderError(
        400,
        "INVALID_RECIPIENT",
        "A valid recipient LagosLife username is required."
      );
    }

    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    const requestHash = idempotencyKey
      ? hashOrderIdempotencyPayload({
          actorUserId: input.actorUserId,
          channel: input.channel,
          customerId: input.customerId,
          orderType: input.orderType,
          gameAmount: input.gameAmount?.toString() ?? null,
          packageId: input.packageId ?? null,
          recipientLagoslifeUsername: normalizedRecipient,
        })
      : null;

    if (idempotencyKey) {
      const existing = await this.prisma.order.findUnique({
        where: { idempotencyKey },
        include: { reservations: true },
      });
      if (existing) {
        if (existing.idempotencyRequestHash !== requestHash) {
          throw new OrderError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was already used with a different order payload."
          );
        }
        return { order: existing, idempotentReplay: true };
      }
    }

    const now = new Date();
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // 1. Deterministic lock ordering: game_accounts (slot_code ASC) -> orders -> customers
        const lockedAccounts = await tx.$queryRaw<LockedGameAccount[]>`
          SELECT id, slot_code, account_role, last_known_balance::text, reserved_for_orders::text, health_status, last_synced_at
          FROM game_accounts
          ORDER BY slot_code ASC
          FOR UPDATE
        `;

        // 2. Release any expired unpaid reservations before checking availability
        await this.releaseExpiredOrdersWithLockedAccounts(
          tx,
          lockedAccounts,
          now,
          input.actorUserId
        );

        // 3. Lock customer row for atomic hoarding-limit & attribution snapshot
        const lockedCustomer = await tx.$queryRaw<
          Array<{
            id: string;
            category: CustomerCategory;
            attributed_partner_id: string | null;
          }>
        >`
          SELECT id, category, attributed_partner_id
          FROM customers
          WHERE id = ${input.customerId}::uuid
          FOR UPDATE
        `;
        const customer = lockedCustomer[0];
        if (!customer) {
          throw new OrderError(404, "CUSTOMER_NOT_FOUND", "Customer record not found.");
        }

        // 4. Load active policies
        const policies = await this.getPolicies(tx);

        // 5. Compute authoritative server-side pricing & snapshot
        let requestedGameAmount: bigint;
        let fiatAmountKobo: bigint;
        let pricingSnapshot: Prisma.InputJsonValue;

        if (input.orderType === OrderType.RETAIL) {
          if (policies.retailPricing.status !== "CONFIGURED") {
            throw new OrderError(
              409,
              "PRICING_UNCONFIGURED",
              "Retail pricing is not configured yet by the Owner."
            );
          }
          const pkg = policies.retailPricing.packages.find(
            (p) => p.id === input.packageId && p.enabled
          );
          if (!pkg) {
            throw new OrderError(
              400,
              "INVALID_RETAIL_PACKAGE",
              "Selected retail package is not available."
            );
          }
          requestedGameAmount = BigInt(pkg.gameAmount);
          fiatAmountKobo = BigInt(pkg.fiatKobo);
          pricingSnapshot = {
            version: 1,
            orderType: OrderType.RETAIL,
            packageId: pkg.id,
            packageName: pkg.name,
            gameAmount: requestedGameAmount.toString(),
            fiatKobo: fiatAmountKobo.toString(),
            capturedAt: now.toISOString(),
          };
        } else {
          if (!policies.bulkPricing.enabled) {
            throw new OrderError(409, "BULK_DISABLED", "Bulk ordering is currently disabled.");
          }
          if (!input.gameAmount || input.gameAmount <= 0n) {
            throw new OrderError(400, "INVALID_AMOUNT", "Bulk order amount is required.");
          }
          requestedGameAmount = input.gameAmount;
          try {
            fiatAmountKobo = calculateBulkOrderFiatKobo(
              requestedGameAmount,
              policies.bulkPricing.priceKoboPerTrillion,
              policies.bulkPricing.minBulkGameAmount
            );
          } catch (err) {
            throw new OrderError(
              400,
              "INVALID_BULK_AMOUNT",
              err instanceof Error ? err.message : "Invalid bulk order amount."
            );
          }
          pricingSnapshot = {
            version: 1,
            orderType: OrderType.BULK,
            priceKoboPerTrillion: policies.bulkPricing.priceKoboPerTrillion.toString(),
            minBulkGameAmount: policies.bulkPricing.minBulkGameAmount.toString(),
            gameAmount: requestedGameAmount.toString(),
            fiatKobo: fiatAmountKobo.toString(),
            capturedAt: now.toISOString(),
          };
        }

        // 6. Enforce per-customer hoarding limits atomically
        const activeUnpaidOrders = await tx.order.findMany({
          where: {
            customerId: customer.id,
            status: {
              in: [
                OrderStatus.AWAITING_PAYMENT,
                OrderStatus.PAYMENT_SUBMITTED,
                OrderStatus.PAYMENT_EXCEPTION_REVIEW,
              ],
            },
          },
          select: { gameAmountRequested: true },
        });

        if (
          activeUnpaidOrders.length >=
          policies.hoardingPolicy.maxActiveUnpaidOrdersPerCustomer
        ) {
          throw new OrderError(
            429,
            "HOARDING_LIMIT_EXCEEDED",
            `Maximum active unpaid orders (${policies.hoardingPolicy.maxActiveUnpaidOrdersPerCustomer}) reached for this customer.`
          );
        }

        let currentReservedForCustomer = 0n;
        for (const o of activeUnpaidOrders) {
          currentReservedForCustomer += BigInt(o.gameAmountRequested.toFixed(0));
        }
        if (
          currentReservedForCustomer + requestedGameAmount >
          policies.hoardingPolicy.maxReservedGameAmountPerCustomer
        ) {
          throw new OrderError(
            429,
            "HOARDING_LIMIT_EXCEEDED",
            "Customer reserved inventory limit exceeded for unpaid orders."
          );
        }

        // 7. Allocate across fresh, ACTIVE accounts (RESERVE slots first, then MAIN_TREASURY)
        const eligibleAccounts = lockedAccounts
          .filter((acc) => {
            if (acc.health_status !== GameAccountHealth.ACTIVE) return false;
            return !isInventoryStale(
              acc.last_synced_at,
              policies.freshnessPolicy.maxAgeMinutes,
              now
            );
          })
          .sort((a, b) => {
            if (a.account_role !== b.account_role) {
              return a.account_role === GameAccountRole.RESERVE ? -1 : 1;
            }
            return a.slot_code.localeCompare(b.slot_code);
          });

        const allocations: Array<{
          account: LockedGameAccount;
          amount: bigint;
          availableAfter: bigint;
          nextReserved: bigint;
        }> = [];
        let remaining = requestedGameAmount;

        for (const acc of eligibleAccounts) {
          if (remaining <= 0n) break;
          const observed = parseDecimalInteger(acc.last_known_balance);
          const reserved = parseDecimalInteger(acc.reserved_for_orders);
          const available = observed > reserved ? observed - reserved : 0n;
          if (available <= 0n) continue;

          const take = available >= remaining ? remaining : available;
          const nextReserved = reserved + take;
          const availableAfter = observed - nextReserved;
          allocations.push({
            account: acc,
            amount: take,
            availableAfter,
            nextReserved,
          });
          remaining -= take;
        }

        if (remaining > 0n) {
          throw new OrderError(
            409,
            "INSUFFICIENT_INVENTORY",
            "Insufficient fresh, active inventory available to reserve this order."
          );
        }

        const expiresAt =
          policies.expiryPolicy.unpaidExpiryMinutes !== null
            ? new Date(now.getTime() + policies.expiryPolicy.unpaidExpiryMinutes * 60_000)
            : null;

        // 8. Persist Order, InventoryReservations, GameAccount.reservedForOrders, and InventoryLedger
        const order = await tx.order.create({
          data: {
            orderNumber: generateOrderNumber(),
            paymentReference: generatePaymentReference(),
            channel: input.channel,
            orderType: input.orderType,
            createdByUserId: input.actorUserId,
            idempotencyKey,
            idempotencyRequestHash: requestHash,
            customerId: customer.id,
            customerCategory: customer.category,
            partnerId: customer.attributed_partner_id,
            recipientLagoslifeUsername: normalizedRecipient,
            gameAmountRequested: requestedGameAmount.toString(),
            fiatAmountKobo,
            pricingSnapshot,
            status: OrderStatus.AWAITING_PAYMENT,
            expiresAt,
          },
        });

        for (const alloc of allocations) {
          await tx.gameAccount.update({
            where: { id: alloc.account.id },
            data: { reservedForOrders: alloc.nextReserved.toString() },
          });

          await tx.inventoryReservation.create({
            data: {
              orderId: order.id,
              gameAccountId: alloc.account.id,
              amount: alloc.amount.toString(),
              status: InventoryReservationStatus.ACTIVE,
              expiresAt,
            },
          });

          await tx.inventoryLedger.create({
            data: {
              gameAccountId: alloc.account.id,
              orderId: order.id,
              entryType: InventoryEntryType.ORDER_RESERVE,
              deltaAmount: (-alloc.amount).toString(),
              balanceAfter: alloc.availableAfter.toString(),
              createdById: input.actorUserId,
              notes: `Reserved for ${order.orderNumber} (${input.channel})`,
            },
          });
        }

        return tx.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { reservations: true },
        });
      }, { maxWait: 15000, timeout: 30000 });

      return { order: created, idempotentReplay: false };
    } catch (err) {
      if (
        idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const existing = await this.prisma.order.findUnique({
          where: { idempotencyKey },
          include: { reservations: true },
        });
        if (existing) {
          if (existing.idempotencyRequestHash !== requestHash) {
            throw new OrderError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency-Key was already used with a different order payload."
            );
          }
          return { order: existing, idempotentReplay: true };
        }
      }
      throw err;
    }
  }

  async cancelOrder(input: {
    orderId: string;
    actorUserId: string;
    requireCustomerId?: string;
    reason: string;
    ipAddress?: string;
  }) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const lockedAccounts = await tx.$queryRaw<LockedGameAccount[]>`
        SELECT id, slot_code, account_role, last_known_balance::text, reserved_for_orders::text, health_status, last_synced_at
        FROM game_accounts
        ORDER BY slot_code ASC
        FOR UPDATE
      `;
      const accountMap = new Map(lockedAccounts.map((a) => [a.id, a]));

      const lockedOrders = await tx.$queryRaw<
        Array<{ id: string; customer_id: string; status: OrderStatus; order_number: string }>
      >`
        SELECT id, customer_id, status, order_number
        FROM orders
        WHERE id = ${input.orderId}::uuid
        FOR UPDATE
      `;
      const orderRow = lockedOrders[0];
      if (!orderRow) {
        throw new OrderError(404, "ORDER_NOT_FOUND", "Order not found.");
      }
      if (input.requireCustomerId && orderRow.customer_id !== input.requireCustomerId) {
        throw new OrderError(403, "FORBIDDEN", "You do not have access to this order.");
      }
      if (orderRow.status !== OrderStatus.AWAITING_PAYMENT) {
        throw new OrderError(
          409,
          "ORDER_NOT_CANCELLABLE",
          `Order ${orderRow.order_number} cannot be cancelled in status ${orderRow.status}.`
        );
      }

      const updatedOrder = await tx.order.update({
        where: { id: orderRow.id },
        data: { status: OrderStatus.CANCELLED },
      });

      const activeReservations = await tx.inventoryReservation.findMany({
        where: { orderId: orderRow.id, status: InventoryReservationStatus.ACTIVE },
      });

      for (const res of activeReservations) {
        const resAmount = BigInt(res.amount.toFixed(0));
        await tx.inventoryReservation.update({
          where: { id: res.id },
          data: {
            status: InventoryReservationStatus.RELEASED,
            releasedAt: now,
            releaseReason: input.reason,
          },
        });

        const acc = accountMap.get(res.gameAccountId);
        if (acc) {
          const observed = parseDecimalInteger(acc.last_known_balance);
          const prevReserved = parseDecimalInteger(acc.reserved_for_orders);
          const nextReserved = prevReserved > resAmount ? prevReserved - resAmount : 0n;
          acc.reserved_for_orders = nextReserved.toString();

          await tx.gameAccount.update({
            where: { id: acc.id },
            data: { reservedForOrders: nextReserved.toString() },
          });

          const availableAfter = observed > nextReserved ? observed - nextReserved : 0n;
          await tx.inventoryLedger.create({
            data: {
              gameAccountId: acc.id,
              orderId: orderRow.id,
              entryType: InventoryEntryType.ORDER_RELEASE,
              deltaAmount: resAmount.toString(),
              balanceAfter: availableAfter.toString(),
              createdById: input.actorUserId,
              notes: `Released on cancel of ${orderRow.order_number}: ${input.reason}`,
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "ORDER_CANCELLED",
          targetEntity: "orders",
          targetId: orderRow.id,
          beforeState: { status: orderRow.status },
          afterState: { status: OrderStatus.CANCELLED },
          reason: input.reason,
          ipAddress: input.ipAddress,
        },
      });

      return updatedOrder;
    }, { maxWait: 15000, timeout: 30000 });
  }
}
