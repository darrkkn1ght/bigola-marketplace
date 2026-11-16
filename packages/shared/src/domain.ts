export const PRIMARY_SUPPLIER_USERNAME = "bigola2823" as const;

export const INITIAL_RESERVE_ACCOUNT_COUNT = 4;
export const TARGET_RESERVE_PER_ACCOUNT = 70_000_000_000_000n; // 70 Trillion
export const INITIAL_ACTIVE_RESERVE_TARGET = 280_000_000_000_000n; // 280 Trillion

export const DEFAULT_BULK_PRICE_KOBO_PER_TRILLION = 100_000n; // ₦1,000.00 in kobo
export const DEFAULT_BULK_MIN_GAME_AMOUNT = 10_000_000_000_000n; // 10 Trillion
export const ONE_TRILLION = 1_000_000_000_000n;

export const DEFAULT_ORDER_EXPIRY_MINUTES = 30;
export const DEFAULT_INVENTORY_MAX_AGE_MINUTES = 60;
export const DEFAULT_MAX_ACTIVE_UNPAID_ORDERS_PER_CUSTOMER = 3;
export const DEFAULT_MAX_RESERVED_GAME_AMOUNT_PER_CUSTOMER = 500_000_000_000_000n; // 500 Trillion

export interface BulkTierConfig {
  minGameAmount: string; // integer string in-game Naira
  priceKoboPerTrillion: string; // integer string kobo
  label?: string;
}

export interface RetailPackageConfig {
  id: string;
  name: string;
  gameAmount: string; // integer string in-game Naira
  fiatKobo: string; // integer string kobo
  enabled: boolean;
  promoFiatKobo?: string | null;
  promoLabel?: string | null;
}

export type CustomerCategory = "CATEGORY_A_PARTNER" | "CATEGORY_B_BIGOLA";

export type CommissionRuleInput =
  | {
      category: "CATEGORY_A_PARTNER";
      partnerShareBps: 5000;
      ownerShareBps: 5000;
    }
  | {
      category: "CATEGORY_B_BIGOLA";
      status: "PENDING_RULE";
    }
  | {
      category: "CATEGORY_B_BIGOLA";
      status: "CONFIGURED";
      partnerShareBps: number;
      ownerShareBps: number;
    };

export type CommissionSplitResult =
  | {
      status: "ACCRUED";
      grossFiatKobo: bigint;
      partnerEntitlementKobo: bigint;
      ownerEntitlementKobo: bigint;
    }
  | {
      status: "PENDING_RULE";
      grossFiatKobo: bigint;
      partnerEntitlementKobo: null;
      ownerEntitlementKobo: null;
    };

/**
 * Calculates immutable commission entitlements from gross verified customer payment (in kobo).
 * - Category A: strictly 50/50 split of full verified customer payment.
 * - Category B: remains PENDING_RULE with null entitlements until Owner configures a rule.
 */
export function calculateCommissionSplit(
  grossFiatKobo: bigint,
  rule: CommissionRuleInput
): CommissionSplitResult {
  if (grossFiatKobo <= 0n) {
    throw new Error("Gross verified payment must be greater than zero kobo.");
  }

  if (rule.category === "CATEGORY_A_PARTNER") {
    const partnerEntitlementKobo = (grossFiatKobo * 5000n) / 10000n;
    const ownerEntitlementKobo = grossFiatKobo - partnerEntitlementKobo;
    return {
      status: "ACCRUED",
      grossFiatKobo,
      partnerEntitlementKobo,
      ownerEntitlementKobo,
    };
  }

  if (rule.status === "PENDING_RULE") {
    return {
      status: "PENDING_RULE",
      grossFiatKobo,
      partnerEntitlementKobo: null,
      ownerEntitlementKobo: null,
    };
  }

  if (
    !Number.isInteger(rule.partnerShareBps) ||
    !Number.isInteger(rule.ownerShareBps) ||
    rule.partnerShareBps < 0 ||
    rule.ownerShareBps < 0 ||
    rule.partnerShareBps + rule.ownerShareBps !== 10000
  ) {
    throw new Error("Configured commission basis points must be non-negative integers summing to 10000.");
  }

  const partnerEntitlementKobo = (grossFiatKobo * BigInt(rule.partnerShareBps)) / 10000n;
  const ownerEntitlementKobo = grossFiatKobo - partnerEntitlementKobo;

  return {
    status: "ACCRUED",
    grossFiatKobo,
    partnerEntitlementKobo,
    ownerEntitlementKobo,
  };
}

/**
 * Computes bulk order fiat cost in kobo from a configurable rate per 1T.
 */
export function calculateBulkOrderFiatKobo(
  gameAmount: bigint,
  priceKoboPerTrillion: bigint = DEFAULT_BULK_PRICE_KOBO_PER_TRILLION,
  minBulkAmount: bigint = DEFAULT_BULK_MIN_GAME_AMOUNT
): bigint {
  if (gameAmount < minBulkAmount) {
    throw new Error(`Bulk orders require at least ${minBulkAmount.toString()} in-game Naira.`);
  }
  if (gameAmount % ONE_TRILLION !== 0n) {
    throw new Error("Bulk orders must be in whole 1 Trillion increments.");
  }
  return (gameAmount / ONE_TRILLION) * priceKoboPerTrillion;
}

export interface BulkOrderQuoteInput {
  priceKoboPerTrillion: bigint;
  minBulkGameAmount: bigint;
  maxBulkGameAmount?: bigint | null;
  bulkIncrementGameAmount?: bigint | null;
  tiers?: Array<{ minGameAmount: bigint; priceKoboPerTrillion: bigint; label?: string }>;
  promoDiscountBps?: number | null;
}

export interface BulkOrderQuoteResult {
  unitPriceKoboPerTrillion: bigint;
  grossFiatKobo: bigint;
  discountKobo: bigint;
  netFiatKobo: bigint;
  appliedTierLabel: string | null;
}

export function calculateBulkOrderQuote(
  gameAmount: bigint,
  config: BulkOrderQuoteInput
): BulkOrderQuoteResult {
  if (gameAmount < config.minBulkGameAmount) {
    throw new Error(`Bulk orders require at least ${config.minBulkGameAmount.toString()} in-game Naira.`);
  }
  if (config.maxBulkGameAmount && gameAmount > config.maxBulkGameAmount) {
    throw new Error(`Bulk orders cannot exceed ${config.maxBulkGameAmount.toString()} in-game Naira.`);
  }
  const increment =
    config.bulkIncrementGameAmount && config.bulkIncrementGameAmount > 0n
      ? config.bulkIncrementGameAmount
      : ONE_TRILLION;
  if (gameAmount % ONE_TRILLION !== 0n) {
    throw new Error("Bulk orders must be in whole 1 Trillion increments.");
  }
  if (gameAmount % increment !== 0n) {
    throw new Error(`Bulk orders must be in multiples of ${increment.toString()} in-game Naira.`);
  }

  let unitPriceKoboPerTrillion = config.priceKoboPerTrillion;
  let appliedTierLabel: string | null = null;
  if (config.tiers && config.tiers.length > 0) {
    const sortedTiers = [...config.tiers].sort((a, b) =>
      a.minGameAmount > b.minGameAmount ? -1 : a.minGameAmount < b.minGameAmount ? 1 : 0
    );
    const matched = sortedTiers.find((t) => gameAmount >= t.minGameAmount);
    if (matched) {
      unitPriceKoboPerTrillion = matched.priceKoboPerTrillion;
      appliedTierLabel = matched.label ?? null;
    }
  }

  const grossFiatKobo = (gameAmount / ONE_TRILLION) * unitPriceKoboPerTrillion;
  const promoBps =
    typeof config.promoDiscountBps === "number" &&
    Number.isInteger(config.promoDiscountBps) &&
    config.promoDiscountBps > 0 &&
    config.promoDiscountBps <= 9000
      ? config.promoDiscountBps
      : 0;
  const discountKobo = promoBps > 0 ? (grossFiatKobo * BigInt(promoBps)) / 10000n : 0n;
  const netFiatKobo = grossFiatKobo - discountKobo;

  return {
    unitPriceKoboPerTrillion,
    grossFiatKobo,
    discountKobo,
    netFiatKobo,
    appliedTierLabel,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("0") && digits.length === 11) {
    return `+234${digits.slice(1)}`;
  }
  if (digits.startsWith("234") && digits.length === 13) {
    return `+${digits}`;
  }
  return digits.startsWith("+") ? digits : `+${digits}`;
}

export function normalizeLagoslifeUsername(username: string): string {
  return username.trim().replace(/^@+/, "").toLowerCase();
}

export function normalizeReferralCode(code: string): string {
  return code.trim().toUpperCase();
}

export function normalizeBankReference(reference: string): string {
  return reference.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function maskIdentifier(value: string, kind: "EMAIL" | "PHONE" | "LAGOSLIFE_USERNAME"): string {
  const trimmed = value.trim();
  if (kind === "EMAIL") {
    const [local, domain] = trimmed.split("@");
    if (!local || !domain) return "***";
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (kind === "PHONE") {
    return trimmed.length <= 4 ? "***" : `***${trimmed.slice(-4)}`;
  }
  return trimmed.length <= 2 ? "***" : `${trimmed.slice(0, 2)}***`;
}

/**
 * Determines whether a GameAccount's lastKnownBalance is stale based on lastSyncedAt
 * and the configured maximum inventory data age in minutes.
 */
export function isInventoryStale(
  lastSyncedAt: Date | string | null | undefined,
  maxAgeMinutes: number = DEFAULT_INVENTORY_MAX_AGE_MINUTES,
  now: Date = new Date()
): boolean {
  if (!lastSyncedAt) return true;
  const syncedMs = typeof lastSyncedAt === "string" ? Date.parse(lastSyncedAt) : lastSyncedAt.getTime();
  if (!Number.isFinite(syncedMs)) return true;
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) return true;
  return now.getTime() - syncedMs > maxAgeMinutes * 60_000;
}

