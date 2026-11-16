import {
  DisbursementChunkStatus,
  DisbursementJobStatus,
  GameAccountHealth,
  InventoryEntryType,
  InventoryReservationStatus,
  NotificationType,
  OrderStatus,
  Prisma,
  UserRole,
  type PrismaClient,
} from "@prisma/client";
import type { Redis } from "ioredis";
import { normalizeLagoslifeUsername } from "@bigola/shared";
import {
  decodeEncryptedSessionBundle,
  LAGOSLIFE_SEND_COOLDOWN_MS,
  LagosLifeAdapter,
  MAX_LAGOSLIFE_TRANSFER_CHUNK,
} from "./lagoslife.js";
import { InventoryError } from "./inventory.js";

export const MAX_TRANSFER_CHUNK = MAX_LAGOSLIFE_TRANSFER_CHUNK; // 100B (100_000_000_000n)
export const ACCOUNT_COOLDOWN_MS = LAGOSLIFE_SEND_COOLDOWN_MS; // 30.5s (30_500ms)
export const DEFAULT_ACCOUNT_MUTEX_TTL_MS = 60_000;

export class DisbursementError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DisbursementError";
  }
}

export interface AccountSplitAllocationInput {
  slotCode?: string;
  gameAccountId?: string;
  amount: bigint;
}

export interface AuthorizeDisbursementJobInput {
  orderId: string;
  actorUserId: string;
  actorRole: UserRole;
  allocations?: AccountSplitAllocationInput[];
  authorizationNote?: string;
  ipAddress?: string;
}

export interface ExecuteDisbursementJobInput {
  jobId: string;
  actorUserId?: string;
  actorRole?: UserRole;
  maxChunksToProcess?: number;
  waitForCooldown?: boolean;
  pinByAccountId?: Record<string, string>;
  ipAddress?: string;
}

export interface ResolveAmbiguousChunkInput {
  jobId: string;
  chunkId: string;
  actorUserId: string;
  actorRole: UserRole;
  outcome: "CONFIRMED_DELIVERED" | "CONFIRMED_NOT_DELIVERED";
  notes: string;
  ipAddress?: string;
}

export interface SerializedDisbursementChunk {
  id: string;
  jobId: string;
  sourceAccountId: string;
  sourceSlotCode: string | null;
  sourceAccountLabel: string | null;
  sourceLagoslifeUsername: string | null;
  recipientUsername: string;
  resolvedTargetId: string | null;
  amount: string;
  idempotencyKey: string;
  status: DisbursementChunkStatus;
  attemptCount: number;
  httpStatus: number | null;
  errorMessage: string | null;
  reconciliationNote: string | null;
  executedAt: string | null;
  createdAt: string;
}

export interface SerializedDisbursementJob {
  id: string;
  orderId: string;
  totalAmount: string;
  deliveredAmount: string;
  remainingAmount: string;
  status: DisbursementJobStatus;
  totalChunks: number;
  completedChunks: number;
  progressPercent: number;
  hasAmbiguousChunks: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  chunks: SerializedDisbursementChunk[];
}

function toBigInt(value: Prisma.Decimal | bigint | number | string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") return BigInt(value.split(".")[0] || "0");
  return BigInt(value.toFixed(0));
}

/**
 * Encodes both the normalized `@username` and resolved LagosLife player ID in `recipientUsername`
 * while staying backward-compatible with plain usernames.
 * Format: `username|targetId`
 */
export function encodeResolvedRecipient(username: string, targetId: string): string {
  const cleanUser = normalizeLagoslifeUsername(username);
  return `${cleanUser}|${targetId.trim()}`;
}

export function decodeResolvedRecipient(stored: string): {
  username: string;
  targetId: string | null;
} {
  const raw = String(stored || "").trim();
  const pipeIdx = raw.indexOf("|");
  if (pipeIdx === -1) {
    return {
      username: normalizeLagoslifeUsername(raw),
      targetId: null,
    };
  }
  return {
    username: normalizeLagoslifeUsername(raw.slice(0, pipeIdx)),
    targetId: raw.slice(pipeIdx + 1).trim() || null,
  };
}

/**
 * Splits an allocation amount into `<= 100B` (`MAX_TRANSFER_CHUNK`) chunks,
 * matching MoneySender's chunking loop (`Math.min(remaining, MAX_TRANSFER_CHUNK)`).
 */
export function splitAmountIntoChunks(
  totalAmount: bigint,
  maxChunk: bigint = MAX_TRANSFER_CHUNK
): bigint[] {
  if (totalAmount <= 0n) {
    throw new DisbursementError(
      400,
      "INVALID_ALLOCATION_AMOUNT",
      "Allocation amount must be greater than zero."
    );
  }
  const chunks: bigint[] = [];
  let remaining = totalAmount;
  while (remaining > 0n) {
    const chunk = remaining > maxChunk ? maxChunk : remaining;
    chunks.push(chunk);
    remaining -= chunk;
  }
  return chunks;
}

/**
 * Persistent Per-Account Mutex & Cooldown Coordinator.
 * Uses Redis keys when a Redis client is provided, plus a deterministic in-memory fallback
 * for isolated tests or local environments when Redis is unavailable.
 *
 * Guarantees:
 * 1. Two workers/requests can NEVER execute concurrent transfers from the same `GameAccount`.
 * 2. Each `GameAccount` enforces a strict 30.5-second (`30,500ms`) cooldown between transfers.
 */
export class AccountTransferCoordinator {
  private readonly memoryLocks = new Map<string, { ownerToken: string; expiresAtMs: number }>();
  private readonly memoryCooldownUntil = new Map<string, number>();

  constructor(
    private readonly redis: Redis | null = null,
    private readonly nowFn: () => number = () => Date.now()
  ) {}

  private lockKey(accountId: string): string {
    return `bigola:disbursement:lock:${accountId}`;
  }

  private cooldownKey(accountId: string): string {
    return `bigola:disbursement:cooldown:${accountId}`;
  }

  async acquireAccountMutex(
    accountId: string,
    ownerToken: string,
    ttlMs: number = DEFAULT_ACCOUNT_MUTEX_TTL_MS
  ): Promise<boolean> {
    const now = this.nowFn();

    if (this.redis) {
      try {
        const res = await this.redis.set(this.lockKey(accountId), ownerToken, "PX", ttlMs, "NX");
        return res === "OK";
      } catch {
        // Fall through to memory lock if Redis command fails
      }
    }

    const existing = this.memoryLocks.get(accountId);
    if (existing && existing.expiresAtMs > now && existing.ownerToken !== ownerToken) {
      return false;
    }
    this.memoryLocks.set(accountId, {
      ownerToken,
      expiresAtMs: now + ttlMs,
    });
    return true;
  }

  async releaseAccountMutex(accountId: string, ownerToken: string): Promise<void> {
    if (this.redis) {
      try {
        const current = await this.redis.get(this.lockKey(accountId));
        if (current === ownerToken) {
          await this.redis.del(this.lockKey(accountId));
        }
      } catch {
        // Ignore Redis cleanup error and clean memory fallback
      }
    }

    const existing = this.memoryLocks.get(accountId);
    if (existing && existing.ownerToken === ownerToken) {
      this.memoryLocks.delete(accountId);
    }
  }

  async isAccountLocked(accountId: string): Promise<boolean> {
    const now = this.nowFn();
    if (this.redis) {
      try {
        const val = await this.redis.get(this.lockKey(accountId));
        if (val) return true;
      } catch {
        // Fallback to memory
      }
    }
    const existing = this.memoryLocks.get(accountId);
    return Boolean(existing && existing.expiresAtMs > now);
  }

  async getRemainingCooldownMs(accountId: string): Promise<number> {
    const now = this.nowFn();
    let untilMs = this.memoryCooldownUntil.get(accountId) ?? 0;

    if (this.redis) {
      try {
        const raw = await this.redis.get(this.cooldownKey(accountId));
        if (raw) {
          const parsed = Number(raw);
          if (Number.isFinite(parsed) && parsed > untilMs) {
            untilMs = parsed;
          }
        }
      } catch {
        // Fallback to memory cooldown
      }
    }

    return Math.max(0, untilMs - now);
  }

  async setAccountCooldown(
    accountId: string,
    cooldownMs: number = ACCOUNT_COOLDOWN_MS
  ): Promise<number> {
    const now = this.nowFn();
    const effectiveWaitMs = Math.max(cooldownMs, ACCOUNT_COOLDOWN_MS);
    const existingUntil = this.memoryCooldownUntil.get(accountId) ?? 0;
    const untilMs = Math.max(existingUntil, now + effectiveWaitMs);

    this.memoryCooldownUntil.set(accountId, untilMs);

    if (this.redis) {
      try {
        const ttlMs = Math.max(1000, untilMs - now + 5000);
        await this.redis.set(this.cooldownKey(accountId), String(untilMs), "PX", ttlMs);
      } catch {
        // Memory fallback already updated
      }
    }

    return untilMs;
  }

  async getAccountCoordinatorState(accountId: string): Promise<{
    locked: boolean;
    cooldownRemainingMs: number;
  }> {
    const [locked, cooldownRemainingMs] = await Promise.all([
      this.isAccountLocked(accountId),
      this.getRemainingCooldownMs(accountId),
    ]);
    return { locked, cooldownRemainingMs };
  }
}

export const VALID_FULFILMENT_SLOT_CODES = [
  "MAIN_TREASURY",
  "RESERVE_1",
  "RESERVE_2",
  "RESERVE_3",
  "RESERVE_4",
] as const;

const VALID_SLOT_CODES = new Set<string>(VALID_FULFILMENT_SLOT_CODES);

export class DisbursementService {
  public readonly coordinator: AccountTransferCoordinator;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryptionKeyHex: string,
    private readonly lagosLifeAdapter: LagosLifeAdapter = new LagosLifeAdapter(),
    options?: {
      redis?: Redis | null;
      disbursementEnabled?: boolean;
      nowFn?: () => number;
      sleepFn?: (ms: number) => Promise<void>;
    }
  ) {
    this.coordinator = new AccountTransferCoordinator(
      options?.redis ?? null,
      options?.nowFn ?? (() => Date.now())
    );
    this.disbursementEnabled = options?.disbursementEnabled ?? false;
    this.sleepFn =
      options?.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private disbursementEnabled: boolean;
  private readonly sleepFn: (ms: number) => Promise<void>;

  public isDisbursementEnabled(): boolean {
    return this.disbursementEnabled;
  }

  public setDisbursementEnabledForTesting(enabled: boolean): void {
    this.disbursementEnabled = enabled;
  }

  /**
   * Authorizes and creates a new `DisbursementJob` and its `<= 100B` `DisbursementChunk` records.
   *
   * Safety & Architecture guarantees:
   * - Requires explicit `OWNER` role authorization. Payment verification NEVER calls this automatically.
   * - Supports all 5 accounts (`MAIN_TREASURY` `bigola2823`, `RESERVE_1`, `RESERVE_2`, `RESERVE_3`, `RESERVE_4`)
   *   in either single-account or multi-account split mode.
   * - Resolves customer `recipientLagoslifeUsername` to an exact LagosLife player ID before job creation.
   */
  async authorizeDisbursementJob(
    input: AuthorizeDisbursementJobInput
  ): Promise<SerializedDisbursementJob> {
    if (input.actorRole !== UserRole.OWNER) {
      throw new DisbursementError(
        403,
        "OWNER_AUTHORIZATION_REQUIRED",
        "Every LagosLife disbursement job requires explicit Owner authorization."
      );
    }

    const order = await this.prisma.order.findUnique({
      where: { id: input.orderId },
      include: {
        reservations: {
          where: { status: InventoryReservationStatus.ACTIVE },
        },
        disbursementJobs: {
          include: { chunks: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!order) {
      throw new DisbursementError(404, "ORDER_NOT_FOUND", "Order not found.");
    }

    const allowedOrderStatuses: OrderStatus[] = [
      OrderStatus.READY_FOR_FULFILMENT,
      OrderStatus.PARTIALLY_FULFILLED,
      OrderStatus.QUEUED,
    ];
    if (!allowedOrderStatuses.includes(order.status)) {
      throw new DisbursementError(
        409,
        "ORDER_NOT_READY_FOR_FULFILMENT",
        `Order ${order.orderNumber} is in status ${order.status}. Payment must be verified before Owner disbursement authorization.`
      );
    }

    const activeJob = order.disbursementJobs.find(
      (j) =>
        j.status === DisbursementJobStatus.PENDING ||
        j.status === DisbursementJobStatus.RUNNING ||
        j.status === DisbursementJobStatus.PAUSED
    );
    if (activeJob) {
      throw new DisbursementError(
        409,
        "ACTIVE_DISBURSEMENT_JOB_EXISTS",
        `Order ${order.orderNumber} already has an active disbursement job (${activeJob.id} in status ${activeJob.status}).`
      );
    }

    const requestedAmount = toBigInt(order.gameAmountRequested);
    const fulfilledAmount = toBigInt(order.fulfilledAmount);
    const remainingOrderAmount =
      requestedAmount > fulfilledAmount ? requestedAmount - fulfilledAmount : 0n;

    if (remainingOrderAmount <= 0n) {
      throw new DisbursementError(
        409,
        "ORDER_ALREADY_FULFILLED",
        `Order ${order.orderNumber} has already been fully fulfilled.`
      );
    }

    const allAccounts = await this.prisma.gameAccount.findMany({
      orderBy: { slotCode: "asc" },
    });

    // Determine account allocations (explicit split across any of the 5 accounts, or from active reservations)
    const normalizedAllocations: Array<{
      account: (typeof allAccounts)[number];
      amount: bigint;
    }> = [];

    if (input.allocations && input.allocations.length > 0) {
      const mergedByAccountId = new Map<
        string,
        { account: (typeof allAccounts)[number]; amount: bigint }
      >();

      for (const item of input.allocations) {
        if (item.amount <= 0n) {
          throw new DisbursementError(
            400,
            "INVALID_ALLOCATION_AMOUNT",
            "Each account split allocation must have a positive amount."
          );
        }

        const matchedAccount = allAccounts.find(
          (acc) =>
            (item.gameAccountId && acc.id === item.gameAccountId) ||
            (item.slotCode && acc.slotCode === item.slotCode.trim().toUpperCase())
        );

        if (!matchedAccount) {
          throw new DisbursementError(
            404,
            "SOURCE_ACCOUNT_NOT_FOUND",
            `GameAccount not found for allocation (${item.slotCode ?? item.gameAccountId ?? "unknown"}).`
          );
        }

        if (matchedAccount.slotCode && !VALID_SLOT_CODES.has(matchedAccount.slotCode)) {
          throw new DisbursementError(
            400,
            "INVALID_ACCOUNT_SLOT",
            `Account slot ${matchedAccount.slotCode} is not one of the 5 canonical fulfilment accounts.`
          );
        }

        const existing = mergedByAccountId.get(matchedAccount.id);
        if (existing) {
          existing.amount += item.amount;
        } else {
          mergedByAccountId.set(matchedAccount.id, {
            account: matchedAccount,
            amount: item.amount,
          });
        }
      }

      normalizedAllocations.push(...mergedByAccountId.values());
    } else if (order.reservations.length > 0) {
      let toAllocate = remainingOrderAmount;
      for (const resv of order.reservations) {
        if (toAllocate <= 0n) break;
        const acc = allAccounts.find((a) => a.id === resv.gameAccountId);
        if (!acc) continue;
        const resvAmt = toBigInt(resv.amount);
        const allocAmount = resvAmt > toAllocate ? toAllocate : resvAmt;
        if (allocAmount > 0n) {
          normalizedAllocations.push({ account: acc, amount: allocAmount });
          toAllocate -= allocAmount;
        }
      }
      if (toAllocate > 0n) {
        throw new DisbursementError(
          409,
          "INSUFFICIENT_RESERVATION_FOR_DEFAULT_PLAN",
          "Active inventory reservations do not cover the remaining order amount; provide explicit account allocations."
        );
      }
    } else {
      throw new DisbursementError(
        400,
        "ALLOCATIONS_REQUIRED",
        "Specify at least one source GameAccount allocation (MAIN_TREASURY or RESERVE_1..4) to authorize disbursement."
      );
    }

    const totalJobAmount = normalizedAllocations.reduce((sum, item) => sum + item.amount, 0n);
    if (totalJobAmount <= 0n) {
      throw new DisbursementError(
        400,
        "INVALID_TOTAL_AMOUNT",
        "Total authorized disbursement amount must be greater than zero."
      );
    }

    if (totalJobAmount > remainingOrderAmount) {
      throw new DisbursementError(
        409,
        "ALLOCATION_EXCEEDS_REMAINING_ORDER_AMOUNT",
        `Authorized split total (${totalJobAmount.toString()}) exceeds the order's remaining unfulfilled amount (${remainingOrderAmount.toString()}).`
      );
    }

    // Validate every selected source account has an active encrypted session and sufficient balance
    let firstValidCookie: string | null = null;
    for (const { account, amount } of normalizedAllocations) {
      if (
        account.healthStatus === GameAccountHealth.DISABLED ||
        account.healthStatus === GameAccountHealth.SESSION_EXPIRED
      ) {
        throw new DisbursementError(
          409,
          "SOURCE_ACCOUNT_NOT_READY",
          `Source account ${account.slotCode} is in health status ${account.healthStatus} and cannot disburse.`
        );
      }

      const session = decodeEncryptedSessionBundle(
        account.encryptedSessionBundle,
        this.encryptionKeyHex
      );
      if (!session || !session.cookie) {
        throw new DisbursementError(
          409,
          "SOURCE_ACCOUNT_NOT_CONNECTED",
          `Source account ${account.slotCode} does not have an authenticated LagosLife session.`
        );
      }

      if (!firstValidCookie) {
        firstValidCookie = session.cookie;
      }

      // Check balance (accounting for any existing reservation for this order on that account)
      const orderReservedOnAccount = order.reservations
        .filter(
          (r) =>
            r.gameAccountId === account.id && r.status === InventoryReservationStatus.ACTIVE
        )
        .reduce((sum, r) => sum + toBigInt(r.amount), 0n);

      const accountReservedTotal = toBigInt(account.reservedForOrders);
      const accountLastKnown = toBigInt(account.lastKnownBalance);

      const otherOrdersReserved =
        accountReservedTotal > orderReservedOnAccount
          ? accountReservedTotal - orderReservedOnAccount
          : 0n;
      const spendableForThisOrder =
        accountLastKnown > otherOrdersReserved ? accountLastKnown - otherOrdersReserved : 0n;

      if (amount > spendableForThisOrder) {
        throw new DisbursementError(
          409,
          "INSUFFICIENT_SOURCE_ACCOUNT_BALANCE",
          `Account ${account.slotCode} has ${spendableForThisOrder.toString()} available for this order, which is less than the allocated ${amount.toString()}.`
        );
      }
    }

    // Resolve recipient LagosLife username to exact player ID BEFORE execution
    const recipientClean = normalizeLagoslifeUsername(order.recipientLagoslifeUsername);
    const resolvedPlayer = await this.lagosLifeAdapter.resolveTargetIdAsync(
      recipientClean,
      firstValidCookie ?? undefined
    );

    if (!resolvedPlayer || !resolvedPlayer.id) {
      throw new DisbursementError(
        409,
        "RECIPIENT_RESOLUTION_FAILED",
        `Could not resolve LagosLife recipient @${recipientClean} to an exact player ID before disbursement.`
      );
    }

    const encodedRecipient = encodeResolvedRecipient(
      resolvedPlayer.username || recipientClean,
      resolvedPlayer.id
    );

    // Build chunk descriptors (<= 100B each) across all allocated accounts
    const chunkDrafts: Array<{
      sourceAccountId: string;
      slotCode: string;
      amount: bigint;
    }> = [];

    for (const { account, amount } of normalizedAllocations) {
      const amounts = splitAmountIntoChunks(amount, MAX_TRANSFER_CHUNK);
      for (const chunkAmount of amounts) {
        chunkDrafts.push({
          sourceAccountId: account.id,
          slotCode: account.slotCode ?? "SLOT",
          amount: chunkAmount,
        });
      }
    }

    const createdJob = await this.prisma.$transaction(
      async (tx) => {
        const job = await tx.disbursementJob.create({
          data: {
            orderId: order.id,
            totalAmount: totalJobAmount.toString(),
            deliveredAmount: "0",
            status: DisbursementJobStatus.PENDING,
            totalChunks: chunkDrafts.length,
            completedChunks: 0,
          },
        });

        const chunkPayloads = chunkDrafts.map((draft, idx) => ({
          jobId: job.id,
          sourceAccountId: draft.sourceAccountId,
          recipientUsername: encodedRecipient,
          amount: draft.amount.toString(),
          idempotencyKey: `disb_${job.id}_c${idx + 1}_${draft.slotCode.toLowerCase()}`,
          status: DisbursementChunkStatus.PENDING,
          attemptCount: 0,
        }));

        let createdChunks;
        if (typeof tx.disbursementChunk.createMany === "function") {
          await tx.disbursementChunk.createMany({ data: chunkPayloads });
          createdChunks = await tx.disbursementChunk.findMany({
            where: { jobId: job.id },
            orderBy: { createdAt: "asc" },
          });
        } else {
          createdChunks = await Promise.all(
            chunkPayloads.map((data) => tx.disbursementChunk.create({ data }))
          );
        }

        if (order.status === OrderStatus.READY_FOR_FULFILMENT) {
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.QUEUED },
          });
        }

        await tx.auditLog.create({
          data: {
            actorUserId: input.actorUserId,
            actionType: "DISBURSEMENT_JOB_AUTHORIZED",
            targetEntity: "disbursement_jobs",
            targetId: job.id,
            afterState: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              recipientUsername: recipientClean,
              resolvedTargetId: resolvedPlayer.id,
              totalAmount: totalJobAmount.toString(),
              totalChunks: chunkDrafts.length,
              allocations: normalizedAllocations.map((a) => ({
                gameAccountId: a.account.id,
                slotCode: a.account.slotCode,
                amount: a.amount.toString(),
              })),
            },
            reason: input.authorizationNote ?? "Owner authorized LagosLife disbursement job.",
            ipAddress: input.ipAddress,
          },
        });

        return { job, chunks: createdChunks };
      },
      { maxWait: 10_000, timeout: 25_000 }
    );

    return this.serializeJob(createdJob.job, createdJob.chunks, allAccounts);
  }

  /**
   * Executes pending chunks for an Owner-authorized `DisbursementJob`.
   *
   * Safety & Duplicate-Prevention Guarantees:
   * - Refuses execution when `disbursementEnabled === false` (`409 DISBURSEMENT_DISABLED`).
   * - Acquires a per-account mutex (`AccountTransferCoordinator`) before touching any account.
   * - Enforces the 30.5-second (`30,500ms`) per-account cooldown.
   * - Records pre-send balance via `/api/save` (`fetchAccountData`).
   * - On timeout / network failure / HTTP 5xx (`UNCERTAIN`), NEVER blindly retries:
   *   reconciles against live `/api/save` balance delta. If still uncertain, marks chunk
   *   `AMBIGUOUS_MANUAL_REVIEW` and pauses the job (`PAUSED`) for Owner inspection.
   */
  async executeJob(input: ExecuteDisbursementJobInput): Promise<SerializedDisbursementJob> {
    if (!this.disbursementEnabled) {
      throw new DisbursementError(
        409,
        "DISBURSEMENT_DISABLED",
        "Live LagosLife disbursement execution is disabled while DISBURSEMENT_ENABLED=false."
      );
    }

    const initialJob = await this.prisma.disbursementJob.findUnique({
      where: { id: input.jobId },
      include: {
        chunks: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!initialJob) {
      throw new DisbursementError(404, "DISBURSEMENT_JOB_NOT_FOUND", "Disbursement job not found.");
    }

    if (initialJob.status === DisbursementJobStatus.COMPLETED) {
      return this.getJobDetail(initialJob.id);
    }

    if (initialJob.status === DisbursementJobStatus.PAUSED) {
      throw new DisbursementError(
        409,
        "DISBURSEMENT_JOB_PAUSED",
        "Disbursement job is paused. Resolve any ambiguous chunks and explicitly resume the job before executing."
      );
    }

    if (initialJob.status === DisbursementJobStatus.FAILED) {
      throw new DisbursementError(
        409,
        "DISBURSEMENT_JOB_FAILED",
        "Disbursement job is in FAILED status and cannot be executed."
      );
    }

    const orderForCheck = await this.prisma.order.findUnique({
      where: { id: initialJob.orderId },
    });
    if (
      !orderForCheck ||
      orderForCheck.status === OrderStatus.REFUNDED ||
      orderForCheck.status === OrderStatus.CANCELLED ||
      orderForCheck.status === OrderStatus.EXPIRED
    ) {
      throw new DisbursementError(
        409,
        "ORDER_NOT_ELIGIBLE_FOR_EXECUTION",
        `Order is ${orderForCheck?.status ?? "MISSING"} and cannot be disbursed.`
      );
    }

    const ambiguousChunk = initialJob.chunks.find(
      (c) => c.status === DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW
    );
    if (ambiguousChunk) {
      await this.prisma.disbursementJob.update({
        where: { id: initialJob.id },
        data: { status: DisbursementJobStatus.PAUSED },
      });
      throw new DisbursementError(
        409,
        "AMBIGUOUS_CHUNK_REQUIRES_REVIEW",
        `Chunk ${ambiguousChunk.id} requires Owner review before further execution.`
      );
    }

    // Transition job to RUNNING and order to DISBURSING
    await this.prisma.$transaction(async (tx) => {
      await tx.disbursementJob.update({
        where: { id: initialJob.id },
        data: {
          status: DisbursementJobStatus.RUNNING,
          startedAt: initialJob.startedAt ?? new Date(),
        },
      });
      await tx.order.update({
        where: { id: initialJob.orderId },
        data: { status: OrderStatus.DISBURSING },
      });
    });

    const maxChunks = input.maxChunksToProcess ?? initialJob.chunks.length;
    const waitForCooldown = input.waitForCooldown ?? false;
    const attemptedChunkIdsInPass = new Set<string>();
    let processedCount = 0;

    while (processedCount < maxChunks) {
      const currentJob = await this.prisma.disbursementJob.findUnique({
        where: { id: initialJob.id },
        include: {
          chunks: {
            orderBy: { createdAt: "asc" },
          },
        },
      });

      if (!currentJob || currentJob.status !== DisbursementJobStatus.RUNNING) {
        break;
      }

      const runnableChunks = currentJob.chunks.filter(
        (c) =>
          !attemptedChunkIdsInPass.has(c.id) &&
          (c.status === DisbursementChunkStatus.PENDING ||
            c.status === DisbursementChunkStatus.FAILED_RETRYABLE)
      );

      if (runnableChunks.length === 0) {
        break;
      }

      // Select a runnable chunk whose source account is ready (supports parallel readiness across multi-account splits)
      let selectedChunk = runnableChunks[0]!;
      let minWaitMs = Number.MAX_SAFE_INTEGER;

      for (const candidate of runnableChunks) {
        const locked = await this.coordinator.isAccountLocked(candidate.sourceAccountId);
        const cooldownMs = await this.coordinator.getRemainingCooldownMs(candidate.sourceAccountId);
        if (!locked && cooldownMs === 0) {
          selectedChunk = candidate;
          minWaitMs = 0;
          break;
        }
        if (!locked && cooldownMs < minWaitMs) {
          selectedChunk = candidate;
          minWaitMs = cooldownMs;
        }
      }

      const remainingCooldown = await this.coordinator.getRemainingCooldownMs(
        selectedChunk.sourceAccountId
      );

      if (remainingCooldown > 0) {
        if (!waitForCooldown) {
          // Return clean progress snapshot while respecting the 30.5s cooldown
          break;
        }
        await this.sleepFn(remainingCooldown);
      }

      attemptedChunkIdsInPass.add(selectedChunk.id);
      const stepOutcome = await this.executeSingleChunk(
        currentJob.id,
        currentJob.orderId,
        selectedChunk.id,
        {
          actorUserId: input.actorUserId,
          pin: input.pinByAccountId?.[selectedChunk.sourceAccountId],
          ipAddress: input.ipAddress,
        }
      );

      processedCount += 1;

      if (
        stepOutcome === "PAUSED_AMBIGUOUS" ||
        stepOutcome === "PAUSED_SESSION_EXPIRED" ||
        stepOutcome === "PAUSED_TERMINAL_FAILURE" ||
        stepOutcome === "ACCOUNT_LOCKED" ||
        stepOutcome === "RATE_LIMITED"
      ) {
        break;
      }
    }

    return this.getJobDetail(initialJob.id);
  }

  /**
   * Validates that a DisbursementJob is eligible for queued worker execution and
   * transitions it to RUNNING (and Order to DISBURSING) without blocking on HTTP.
   */
  async prepareJobForQueuedExecution(input: {
    jobId: string;
    actorUserId?: string;
    actorRole?: UserRole;
  }): Promise<{ job: SerializedDisbursementJob; alreadyCompleted: boolean }> {
    if (input.actorRole && input.actorRole !== UserRole.OWNER) {
      throw new DisbursementError(
        403,
        "OWNER_AUTHORIZATION_REQUIRED",
        "Only the Owner can execute LagosLife disbursement jobs."
      );
    }

    if (!this.disbursementEnabled) {
      throw new DisbursementError(
        409,
        "DISBURSEMENT_DISABLED",
        "Live LagosLife disbursement execution is disabled while DISBURSEMENT_ENABLED=false."
      );
    }

    const initialJob = await this.prisma.disbursementJob.findUnique({
      where: { id: input.jobId },
      include: { chunks: { orderBy: { createdAt: "asc" } } },
    });

    if (!initialJob) {
      throw new DisbursementError(404, "DISBURSEMENT_JOB_NOT_FOUND", "Disbursement job not found.");
    }

    if (initialJob.status === DisbursementJobStatus.COMPLETED) {
      return { job: await this.getJobDetail(initialJob.id), alreadyCompleted: true };
    }

    if (initialJob.status === DisbursementJobStatus.PAUSED) {
      throw new DisbursementError(
        409,
        "DISBURSEMENT_JOB_PAUSED",
        "Disbursement job is paused. Resolve any ambiguous chunks and explicitly resume the job before executing."
      );
    }

    if (initialJob.status === DisbursementJobStatus.FAILED) {
      throw new DisbursementError(
        409,
        "DISBURSEMENT_JOB_FAILED",
        "Disbursement job is in FAILED status and cannot be executed."
      );
    }

    const orderForCheck = await this.prisma.order.findUnique({
      where: { id: initialJob.orderId },
    });
    if (
      !orderForCheck ||
      orderForCheck.status === OrderStatus.REFUNDED ||
      orderForCheck.status === OrderStatus.CANCELLED ||
      orderForCheck.status === OrderStatus.EXPIRED
    ) {
      throw new DisbursementError(
        409,
        "ORDER_NOT_ELIGIBLE_FOR_EXECUTION",
        `Order is ${orderForCheck?.status ?? "MISSING"} and cannot be disbursed.`
      );
    }

    const ambiguousChunk = initialJob.chunks.find(
      (c) => c.status === DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW
    );
    if (ambiguousChunk) {
      await this.prisma.disbursementJob.update({
        where: { id: initialJob.id },
        data: { status: DisbursementJobStatus.PAUSED },
      });
      throw new DisbursementError(
        409,
        "AMBIGUOUS_CHUNK_REQUIRES_REVIEW",
        `Chunk ${ambiguousChunk.id} requires Owner review before further execution.`
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.disbursementJob.update({
        where: { id: initialJob.id },
        data: {
          status: DisbursementJobStatus.RUNNING,
          startedAt: initialJob.startedAt ?? new Date(),
        },
      });
      await tx.order.update({
        where: { id: initialJob.orderId },
        data: { status: OrderStatus.DISBURSING },
      });
    });

    return { job: await this.getJobDetail(initialJob.id), alreadyCompleted: false };
  }

  /**
   * Worker-oriented non-blocking step processor for multi-pipeline concurrency.
   * Executes at most one ready chunk per distinct unlocked/off-cooldown account in this pass,
   * then returns `nextDelayMs` if runnable chunks remain on cooldown/lock so BullMQ can
   * reschedule without holding a worker slot or losing state on restart.
   */
  async processJobStepForWorker(input: {
    jobId: string;
    actorUserId?: string;
    pinByAccountId?: Record<string, string>;
  }): Promise<{ job: SerializedDisbursementJob | null; nextDelayMs: number | null }> {
    if (!this.disbursementEnabled) {
      return { job: null, nextDelayMs: null };
    }

    const job = await this.prisma.disbursementJob.findUnique({
      where: { id: input.jobId },
      include: { chunks: { orderBy: { createdAt: "asc" } } },
    });
    if (!job || job.status !== DisbursementJobStatus.RUNNING) {
      return { job: job ? await this.getJobDetail(job.id) : null, nextDelayMs: null };
    }

    const orderForCheck = await this.prisma.order.findUnique({
      where: { id: job.orderId },
    });
    if (
      !orderForCheck ||
      orderForCheck.status === OrderStatus.REFUNDED ||
      orderForCheck.status === OrderStatus.CANCELLED ||
      orderForCheck.status === OrderStatus.EXPIRED
    ) {
      await this.prisma.disbursementJob.update({
        where: { id: job.id },
        data: { status: DisbursementJobStatus.PAUSED },
      });
      return { job: await this.getJobDetail(job.id), nextDelayMs: null };
    }

    const runnable = job.chunks.filter(
      (c) =>
        c.status === DisbursementChunkStatus.PENDING ||
        c.status === DisbursementChunkStatus.FAILED_RETRYABLE
    );

    if (runnable.length === 0) {
      return { job: await this.getJobDetail(job.id), nextDelayMs: null };
    }

    // Group first runnable chunk per distinct source account so multi-account splits advance together
    const firstChunkPerAccount = new Map<string, (typeof runnable)[number]>();
    for (const c of runnable) {
      if (!firstChunkPerAccount.has(c.sourceAccountId)) {
        firstChunkPerAccount.set(c.sourceAccountId, c);
      }
    }

    for (const [accountId, chunk] of firstChunkPerAccount.entries()) {
      const latestJob = await this.prisma.disbursementJob.findUnique({ where: { id: job.id } });
      if (!latestJob || latestJob.status !== DisbursementJobStatus.RUNNING) {
        break;
      }

      const [locked, cooldownMs] = await Promise.all([
        this.coordinator.isAccountLocked(accountId),
        this.coordinator.getRemainingCooldownMs(accountId),
      ]);
      if (locked || cooldownMs > 0) {
        continue;
      }

      const outcome = await this.executeSingleChunk(job.id, job.orderId, chunk.id, {
        actorUserId: input.actorUserId,
        pin: input.pinByAccountId?.[accountId],
      });

      if (
        outcome === "PAUSED_AMBIGUOUS" ||
        outcome === "PAUSED_SESSION_EXPIRED" ||
        outcome === "PAUSED_TERMINAL_FAILURE"
      ) {
        return { job: await this.getJobDetail(job.id), nextDelayMs: null };
      }
    }

    // Re-evaluate remaining runnable chunks to compute next BullMQ delay if needed
    const refreshed = await this.prisma.disbursementJob.findUnique({
      where: { id: job.id },
      include: { chunks: { orderBy: { createdAt: "asc" } } },
    });
    if (!refreshed || refreshed.status !== DisbursementJobStatus.RUNNING) {
      return { job: refreshed ? await this.getJobDetail(refreshed.id) : null, nextDelayMs: null };
    }

    const remainingRunnable = refreshed.chunks.filter(
      (c) =>
        c.status === DisbursementChunkStatus.PENDING ||
        c.status === DisbursementChunkStatus.FAILED_RETRYABLE
    );
    if (remainingRunnable.length === 0) {
      return { job: await this.getJobDetail(refreshed.id), nextDelayMs: null };
    }

    let minWaitMs = Number.MAX_SAFE_INTEGER;
    const seenAccounts = new Set<string>();
    for (const c of remainingRunnable) {
      if (seenAccounts.has(c.sourceAccountId)) continue;
      seenAccounts.add(c.sourceAccountId);
      const [locked, cooldownMs] = await Promise.all([
        this.coordinator.isAccountLocked(c.sourceAccountId),
        this.coordinator.getRemainingCooldownMs(c.sourceAccountId),
      ]);
      const waitMs = locked ? Math.max(2000, cooldownMs) : cooldownMs;
      if (waitMs < minWaitMs) minWaitMs = waitMs;
    }

    const nextDelayMs =
      minWaitMs === Number.MAX_SAFE_INTEGER ? 2000 : Math.max(500, minWaitMs + 100);
    return { job: await this.getJobDetail(refreshed.id), nextDelayMs };
  }

  /**
   * Startup recovery for crashed/restarted workers:
   * 1. Any chunk left in IN_FLIGHT is NEVER blindly retried — it moves to AMBIGUOUS_MANUAL_REVIEW
   *    and its job is PAUSED with an audit log entry.
   * 2. Returns IDs of healthy RUNNING jobs that can be safely re-enqueued.
   */
  async recoverStaleInFlightChunksAndJobs(): Promise<{
    pausedAmbiguousJobIds: string[];
    resumableRunningJobIds: string[];
  }> {
    const runningJobs = await this.prisma.disbursementJob.findMany({
      where: { status: DisbursementJobStatus.RUNNING },
      include: { chunks: { orderBy: { createdAt: "asc" } } },
    });

    const pausedAmbiguousJobIds: string[] = [];
    const resumableRunningJobIds: string[] = [];

    for (const job of runningJobs) {
      const staleInFlight = job.chunks.filter(
        (c) => c.status === DisbursementChunkStatus.IN_FLIGHT
      );
      if (staleInFlight.length > 0) {
        await this.prisma.$transaction(async (tx) => {
          for (const c of staleInFlight) {
            const note =
              "Worker restarted while chunk was IN_FLIGHT; paused for Owner live balance verification before any retry.";
            await tx.disbursementChunk.update({
              where: { id: c.id },
              data: {
                status: DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW,
                errorMessage: note,
                reconciliationNote: note,
              },
            });
            await tx.auditLog.create({
              data: {
                actorUserId: null,
                actionType: "DISBURSEMENT_CHUNK_CRASH_RECOVERY_PAUSED",
                targetEntity: "disbursement_chunks",
                targetId: c.id,
                afterState: { jobId: job.id, orderId: job.orderId, chunkId: c.id },
                reason: note,
              },
            });
          }
          await tx.disbursementJob.update({
            where: { id: job.id },
            data: { status: DisbursementJobStatus.PAUSED },
          });
        });
        pausedAmbiguousJobIds.push(job.id);
        continue;
      }

      const hasAmbiguous = job.chunks.some(
        (c) => c.status === DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW
      );
      if (hasAmbiguous) {
        await this.prisma.disbursementJob.update({
          where: { id: job.id },
          data: { status: DisbursementJobStatus.PAUSED },
        });
        pausedAmbiguousJobIds.push(job.id);
        continue;
      }

      const hasRunnable = job.chunks.some(
        (c) =>
          c.status === DisbursementChunkStatus.PENDING ||
          c.status === DisbursementChunkStatus.FAILED_RETRYABLE
      );
      if (hasRunnable) {
        resumableRunningJobIds.push(job.id);
      }
    }

    return { pausedAmbiguousJobIds, resumableRunningJobIds };
  }

  /**
   * Returns a live operational overview of all 5 LagosLife account pipelines,
   * coordinator locks/cooldowns, active/recent DisbursementJobs, and exceptions.
   */
  async getOperationalPipelineOverview() {
    const [accounts, jobs] = await Promise.all([
      this.prisma.gameAccount.findMany({ orderBy: { slotCode: "asc" } }),
      this.prisma.disbursementJob.findMany({
        include: {
          chunks: { orderBy: { createdAt: "asc" } },
          order: {
            select: {
              id: true,
              orderNumber: true,
              recipientLagoslifeUsername: true,
              status: true,
              gameAmountRequested: true,
              gameAmountDelivered: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 40,
      }),
    ]);

    const accountStates = await Promise.all(
      accounts.map(async (acc) => {
        const coord = await this.coordinator.getAccountCoordinatorState(acc.id);
        const decoded = decodeEncryptedSessionBundle(
          acc.encryptedSessionBundle,
          this.encryptionKeyHex
        );
        const observed = toBigInt(acc.lastKnownBalance);
        const reserved = toBigInt(acc.reservedForOrders);
        const netAvailable = observed > reserved ? observed - reserved : 0n;

        let activeChunkCount = 0;
        let rateLimitedChunkCount = 0;
        let ambiguousChunkCount = 0;
        for (const j of jobs) {
          for (const c of j.chunks) {
            if (c.sourceAccountId !== acc.id) continue;
            if (
              (j.status === DisbursementJobStatus.RUNNING ||
                j.status === DisbursementJobStatus.PENDING) &&
              (c.status === DisbursementChunkStatus.PENDING ||
                c.status === DisbursementChunkStatus.IN_FLIGHT ||
                c.status === DisbursementChunkStatus.FAILED_RETRYABLE)
            ) {
              activeChunkCount++;
            }
            if (c.httpStatus === 429 && c.status === DisbursementChunkStatus.FAILED_RETRYABLE) {
              rateLimitedChunkCount++;
            }
            if (c.status === DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW) {
              ambiguousChunkCount++;
            }
          }
        }

        const connectionStatus =
          acc.healthStatus === GameAccountHealth.SESSION_EXPIRED
            ? "SESSION_EXPIRED"
            : decoded?.cookie
              ? "CONNECTED"
              : "DISCONNECTED";

        return {
          id: acc.id,
          slotCode: acc.slotCode,
          accountRole: acc.accountRole,
          lagoslifeUsername: acc.lagoslifeUsername,
          healthStatus: acc.healthStatus,
          connectionStatus,
          observedBalance: observed.toString(),
          reservedForOrders: reserved.toString(),
          netAvailableBalance: netAvailable.toString(),
          lastSyncedAt: acc.lastSyncedAt ? acc.lastSyncedAt.toISOString() : null,
          locked: coord.locked,
          cooldownRemainingMs: coord.cooldownRemainingMs,
          activeChunkCount,
          rateLimitedChunkCount,
          ambiguousChunkCount,
        };
      })
    );

    const accountMap = new Map(accounts.map((a) => [a.id, a]));
    const serializedJobs = jobs.map((j) => {
      const base = this.serializeJob(j, j.chunks, accounts);
      const allocatedSlotCodes = Array.from(
        new Set(
          j.chunks
            .map((c) => accountMap.get(c.sourceAccountId)?.slotCode)
            .filter((s): s is string => Boolean(s))
        )
      );
      const rateLimitedChunks = j.chunks.filter(
        (c) => c.httpStatus === 429 && c.status === DisbursementChunkStatus.FAILED_RETRYABLE
      ).length;
      const ambiguousChunks = j.chunks.filter(
        (c) => c.status === DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW
      ).length;

      return {
        ...base,
        orderNumber: j.order?.orderNumber ?? null,
        orderStatus: j.order?.status ?? null,
        recipientLagoslifeUsername: j.order?.recipientLagoslifeUsername ?? null,
        allocatedSlotCodes,
        rateLimitedChunks,
        ambiguousChunks,
      };
    });

    return {
      disbursementEnabled: this.disbursementEnabled,
      summary: {
        runningJobs: jobs.filter((j) => j.status === DisbursementJobStatus.RUNNING).length,
        queuedJobs: jobs.filter((j) => j.status === DisbursementJobStatus.PENDING).length,
        pausedJobs: jobs.filter((j) => j.status === DisbursementJobStatus.PAUSED).length,
        completedJobs: jobs.filter((j) => j.status === DisbursementJobStatus.COMPLETED).length,
        failedJobs: jobs.filter((j) => j.status === DisbursementJobStatus.FAILED).length,
        expiredSessionAccountsCount: accountStates.filter(
          (a) => a.connectionStatus === "SESSION_EXPIRED"
        ).length,
        ambiguousChunksCount: serializedJobs.reduce((acc, j) => acc + j.ambiguousChunks, 0),
        rateLimitedChunksCount: serializedJobs.reduce((acc, j) => acc + j.rateLimitedChunks, 0),
      },
      accounts: accountStates,
      jobs: serializedJobs,
    };
  }

  /**
   * Executes a single chunk with per-account mutex locking, 30.5s cooldown enforcement,
   * pre/post `/api/save` balance verification, and transactional ledger accounting.
   */
  async executeSingleChunk(
    jobId: string,
    orderId: string,
    chunkId: string,
    context?: {
      actorUserId?: string;
      pin?: string;
      ipAddress?: string;
    }
  ): Promise<
    | "SUCCEEDED"
    | "RECONCILED_SUCCEEDED"
    | "RECONCILED_NOT_SENT"
    | "RATE_LIMITED"
    | "ACCOUNT_LOCKED"
    | "COOLDOWN_ACTIVE"
    | "PAUSED_AMBIGUOUS"
    | "PAUSED_SESSION_EXPIRED"
    | "PAUSED_TERMINAL_FAILURE"
  > {
    if (!this.disbursementEnabled) {
      throw new DisbursementError(
        409,
        "DISBURSEMENT_DISABLED",
        "Live LagosLife disbursement execution is disabled while DISBURSEMENT_ENABLED=false."
      );
    }

    const chunk = await this.prisma.disbursementChunk.findUnique({
      where: { id: chunkId },
    });
    if (!chunk || chunk.jobId !== jobId) {
      throw new DisbursementError(404, "DISBURSEMENT_CHUNK_NOT_FOUND", "Disbursement chunk not found.");
    }

    if (chunk.status === DisbursementChunkStatus.SUCCEEDED) {
      return "SUCCEEDED";
    }

    if (
      chunk.status !== DisbursementChunkStatus.PENDING &&
      chunk.status !== DisbursementChunkStatus.FAILED_RETRYABLE
    ) {
      throw new DisbursementError(
        409,
        "CHUNK_NOT_EXECUTABLE",
        `Chunk ${chunk.id} is in status ${chunk.status} and cannot be executed automatically.`
      );
    }

    const chunkAmount = toBigInt(chunk.amount);
    const ownerToken = `job_${jobId}_chunk_${chunk.id}_${Date.now()}`;
    const lockAcquired = await this.coordinator.acquireAccountMutex(
      chunk.sourceAccountId,
      ownerToken,
      DEFAULT_ACCOUNT_MUTEX_TTL_MS
    );

    if (!lockAcquired) {
      return "ACCOUNT_LOCKED";
    }

    try {
      const remainingCooldown = await this.coordinator.getRemainingCooldownMs(
        chunk.sourceAccountId
      );
      if (remainingCooldown > 0) {
        return "COOLDOWN_ACTIVE";
      }

      const account = await this.prisma.gameAccount.findUnique({
        where: { id: chunk.sourceAccountId },
      });

      if (!account) {
        throw new DisbursementError(
          404,
          "SOURCE_ACCOUNT_NOT_FOUND",
          `Source account ${chunk.sourceAccountId} not found.`
        );
      }

      const session = decodeEncryptedSessionBundle(
        account.encryptedSessionBundle,
        this.encryptionKeyHex
      );

      if (!session || !session.cookie) {
        await this.pauseJobOnAccountError(
          jobId,
          chunk.id,
          account.id,
          "Source account session is missing or could not be decrypted.",
          true
        );
        return "PAUSED_SESSION_EXPIRED";
      }

      // 1. Fetch live pre-send balance via `/api/save` for authoritative balance-delta reconciliation
      const preSave = await this.lagosLifeAdapter.fetchAccountData(session.cookie);
      if (!preSave.ok) {
        if (preSave.status === 401 || preSave.status === 403) {
          await this.pauseJobOnAccountError(
            jobId,
            chunk.id,
            account.id,
            "LagosLife session expired during pre-send balance verification (/api/save).",
            true
          );
          return "PAUSED_SESSION_EXPIRED";
        }
        // Pre-send check failed BEFORE calling /api/send — safe to mark retryable
        await this.prisma.disbursementChunk.update({
          where: { id: chunk.id },
          data: {
            status: DisbursementChunkStatus.FAILED_RETRYABLE,
            httpStatus: preSave.status,
            errorMessage: `Pre-send /api/save check failed: ${preSave.error ?? "Upstream unavailable"}`,
          },
        });
        return "RECONCILED_NOT_SENT";
      }

      const preSendBalance = preSave.money ?? toBigInt(account.lastKnownBalance);
      if (preSendBalance < chunkAmount) {
        await this.pauseJobOnAccountError(
          jobId,
          chunk.id,
          account.id,
          `Live LagosLife balance (${preSendBalance.toString()}) on ${account.slotCode} is lower than chunk amount (${chunkAmount.toString()}).`,
          false
        );
        return "PAUSED_TERMINAL_FAILURE";
      }

      // Resolve targetId from stored recipient string or live lookup
      const decodedRecipient = decodeResolvedRecipient(chunk.recipientUsername);
      let targetId = decodedRecipient.targetId;
      if (!targetId) {
        const resolved = await this.lagosLifeAdapter.resolveTargetIdAsync(
          decodedRecipient.username,
          session.cookie
        );
        if (!resolved?.id) {
          await this.pauseJobOnAccountError(
            jobId,
            chunk.id,
            account.id,
            `Failed to resolve recipient @${decodedRecipient.username} to an exact LagosLife player ID.`,
            false
          );
          return "PAUSED_TERMINAL_FAILURE";
        }
        targetId = resolved.id;
      }

      // 2. Mark chunk IN_FLIGHT in PostgreSQL BEFORE issuing HTTP POST /api/send
      await this.prisma.disbursementChunk.update({
        where: { id: chunk.id },
        data: {
          status: DisbursementChunkStatus.IN_FLIGHT,
          attemptCount: { increment: 1 },
          errorMessage: null,
        },
      });

      // 3. Execute LagosLife POST /api/send
      const sendResult = await this.lagosLifeAdapter.sendCurrencyChunk({
        cookie: session.cookie,
        targetId,
        amount: chunkAmount,
        idempotencyKey: chunk.idempotencyKey,
        pin: context?.pin,
      });

      // Case A: Confirmed HTTP 200 success
      if (sendResult.outcome === "SUCCEEDED") {
        await this.coordinator.setAccountCooldown(account.id, ACCOUNT_COOLDOWN_MS);
        await this.commitConfirmedChunkDelivery({
          jobId,
          orderId,
          chunkId: chunk.id,
          accountId: account.id,
          chunkAmount,
          httpStatus: sendResult.status,
          postSendBalanceHint: preSendBalance - chunkAmount,
          reconciliationNote: null,
          actorUserId: context?.actorUserId,
          ipAddress: context?.ipAddress,
        });
        return "SUCCEEDED";
      }

      // Case B: HTTP 429 Rate Limit (transfer was not executed; apply rate-limit cooldown)
      if (sendResult.outcome === "RATE_LIMITED") {
        const waitMs = sendResult.retryAfterMs ?? ACCOUNT_COOLDOWN_MS;
        await this.coordinator.setAccountCooldown(account.id, waitMs);
        await this.prisma.disbursementChunk.update({
          where: { id: chunk.id },
          data: {
            status: DisbursementChunkStatus.FAILED_RETRYABLE,
            httpStatus: 429,
            errorMessage: sendResult.message,
          },
        });
        return "RATE_LIMITED";
      }

      // Case C: HTTP 401/403 Session Expired
      if (sendResult.outcome === "SESSION_EXPIRED") {
        await this.pauseJobOnAccountError(
          jobId,
          chunk.id,
          account.id,
          `LagosLife session expired during /api/send (HTTP ${sendResult.status}).`,
          true
        );
        return "PAUSED_SESSION_EXPIRED";
      }

      // Case D: HTTP 400/404/422 Definitive Upstream Rejection
      if (sendResult.outcome === "DEFINITIVE_FAILURE") {
        await this.prisma.$transaction(async (tx) => {
          await tx.disbursementChunk.update({
            where: { id: chunk.id },
            data: {
              status: DisbursementChunkStatus.FAILED_TERMINAL,
              httpStatus: sendResult.status,
              errorMessage: sendResult.message,
            },
          });
          await tx.disbursementJob.update({
            where: { id: jobId },
            data: { status: DisbursementJobStatus.PAUSED },
          });
        });
        return "PAUSED_TERMINAL_FAILURE";
      }

      // Case E: UNCERTAIN (Timeout, connection reset, HTTP 5xx)
      // CRITICAL DUPLICATE-PREVENTION: Never blindly retry! Reconcile against live /api/save balance.
      await this.coordinator.setAccountCooldown(account.id, ACCOUNT_COOLDOWN_MS);
      const postSave = await this.lagosLifeAdapter.fetchAccountData(session.cookie);

      if (postSave.ok && postSave.money !== null) {
        const delta = preSendBalance - postSave.money;

        if (delta === chunkAmount) {
          // Live balance dropped by the exact chunk amount -> transfer SUCCEEDED upstream!
          await this.commitConfirmedChunkDelivery({
            jobId,
            orderId,
            chunkId: chunk.id,
            accountId: account.id,
            chunkAmount,
            httpStatus: sendResult.status || 200,
            postSendBalanceHint: postSave.money,
            reconciliationNote: `Reconciled as DELIVERED via live /api/save balance delta (-${chunkAmount.toString()}) after uncertain /api/send response (${sendResult.message}).`,
            actorUserId: context?.actorUserId,
            ipAddress: context?.ipAddress,
          });
          return "RECONCILED_SUCCEEDED";
        }

        if (delta === 0n) {
          // Live balance is completely unchanged -> transfer did NOT execute upstream.
          // Advance idempotency key for the next clean attempt and mark FAILED_RETRYABLE.
          const nextKey = `${chunk.idempotencyKey}_r${chunk.attemptCount + 1}`;
          await this.prisma.disbursementChunk.update({
            where: { id: chunk.id },
            data: {
              status: DisbursementChunkStatus.FAILED_RETRYABLE,
              idempotencyKey: nextKey,
              httpStatus: sendResult.status || null,
              errorMessage: sendResult.message,
              reconciliationNote: `Reconciled as NOT SENT via live /api/save balance check (balance remained ${postSave.money.toString()}). Safe to retry.`,
            },
          });
          return "RECONCILED_NOT_SENT";
        }
      }

      // Result remains uncertain -> mark chunk AMBIGUOUS_MANUAL_REVIEW and PAUSE job for Owner review
      const ambiguousReason =
        postSave.ok && postSave.money !== null
          ? `Uncertain /api/send response (${sendResult.message}); pre-balance=${preSendBalance.toString()}, post-balance=${postSave.money.toString()} (unexpected delta ${(preSendBalance - postSave.money).toString()}). Paused for Owner review.`
          : `Uncertain /api/send response (${sendResult.message}) and post-send /api/save reconciliation failed (${postSave.error ?? "unavailable"}). Paused for Owner review.`;

      await this.prisma.$transaction(async (tx) => {
        await tx.disbursementChunk.update({
          where: { id: chunk.id },
          data: {
            status: DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW,
            httpStatus: sendResult.status || null,
            errorMessage: sendResult.message,
            reconciliationNote: ambiguousReason,
          },
        });
        await tx.disbursementJob.update({
          where: { id: jobId },
          data: { status: DisbursementJobStatus.PAUSED },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: context?.actorUserId ?? null,
            actionType: "DISBURSEMENT_CHUNK_AMBIGUOUS_PAUSED",
            targetEntity: "disbursement_chunks",
            targetId: chunk.id,
            afterState: {
              jobId,
              orderId,
              sourceAccountId: account.id,
              slotCode: account.slotCode,
              chunkAmount: chunkAmount.toString(),
              reconciliationNote: ambiguousReason,
            },
            reason: ambiguousReason,
            ipAddress: context?.ipAddress,
          },
        });
      });

      return "PAUSED_AMBIGUOUS";
    } finally {
      await this.coordinator.releaseAccountMutex(chunk.sourceAccountId, ownerToken);
    }
  }

  /**
   * Commits a confirmed chunk transfer transactionally across:
   * - `DisbursementChunk` (`SUCCEEDED`)
   * - `DisbursementJob` (`deliveredAmount`, `completedChunks`, `status`)
   * - `GameAccount` (`lastKnownBalance`, `reservedForOrders`, `healthStatus`)
   * - `InventoryReservation` (consumes reservation for this order)
   * - `InventoryLedger` (`InventoryEntryType.DISBURSEMENT_DEBIT`)
   * - `Order` (`fulfilledAmount`, `status` -> `PARTIALLY_FULFILLED` / `COMPLETED`)
   */
  private async commitConfirmedChunkDelivery(params: {
    jobId: string;
    orderId: string;
    chunkId: string;
    accountId: string;
    chunkAmount: bigint;
    httpStatus: number | null;
    postSendBalanceHint?: bigint;
    reconciliationNote: string | null;
    actorUserId?: string;
    ipAddress?: string;
  }): Promise<void> {
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const chunk = await tx.disbursementChunk.findUnique({
        where: { id: params.chunkId },
      });
      if (!chunk || chunk.status === DisbursementChunkStatus.SUCCEEDED) {
        return;
      }

      await tx.disbursementChunk.update({
        where: { id: params.chunkId },
        data: {
          status: DisbursementChunkStatus.SUCCEEDED,
          httpStatus: params.httpStatus ?? 200,
          errorMessage: null,
          reconciliationNote: params.reconciliationNote ?? chunk.reconciliationNote,
          executedAt: now,
        },
      });

      // Consume matching active InventoryReservation on this source account (or across order reservations)
      const activeReservations = await tx.inventoryReservation.findMany({
        where: {
          orderId: params.orderId,
          status: InventoryReservationStatus.ACTIVE,
        },
        orderBy: { createdAt: "asc" },
      });

      let reservationToConsume = params.chunkAmount;
      let consumedOnSourceAccount = 0n;

      // First consume reservation on the exact source account
      for (const resv of activeReservations.filter((r) => r.gameAccountId === params.accountId)) {
        if (reservationToConsume <= 0n) break;
        const resvAmt = toBigInt(resv.amount);
        if (resvAmt <= reservationToConsume) {
          consumedOnSourceAccount += resvAmt;
          reservationToConsume -= resvAmt;
          await tx.inventoryReservation.update({
            where: { id: resv.id },
            data: {
              amount: "0",
              status: InventoryReservationStatus.CONSUMED,
              releasedAt: now,
            },
          });
        } else {
          consumedOnSourceAccount += reservationToConsume;
          await tx.inventoryReservation.update({
            where: { id: resv.id },
            data: {
              amount: (resvAmt - reservationToConsume).toString(),
            },
          });
          reservationToConsume = 0n;
        }
      }

      // If the Owner split fulfilment onto another eligible account than originally reserved,
      // release the corresponding reservation amount on the other reserved account(s) so reservations never stay stuck.
      if (reservationToConsume > 0n) {
        for (const resv of activeReservations.filter((r) => r.gameAccountId !== params.accountId)) {
          if (reservationToConsume <= 0n) break;
          const resvAmt = toBigInt(resv.amount);
          const releaseAmt =
            resvAmt <= reservationToConsume ? resvAmt : reservationToConsume;

          if (releaseAmt > 0n) {
            const otherAcc = await tx.gameAccount.findUnique({
              where: { id: resv.gameAccountId },
            });
            if (otherAcc) {
              const otherReserved = toBigInt(otherAcc.reservedForOrders);
              const nextOtherReserved =
                otherReserved > releaseAmt ? otherReserved - releaseAmt : 0n;
              await tx.gameAccount.update({
                where: { id: otherAcc.id },
                data: { reservedForOrders: nextOtherReserved.toString() },
              });
            }

            if (resvAmt <= reservationToConsume) {
              await tx.inventoryReservation.update({
                where: { id: resv.id },
                data: {
                  amount: "0",
                  status: InventoryReservationStatus.CONSUMED,
                  releasedAt: now,
                },
              });
            } else {
              await tx.inventoryReservation.update({
                where: { id: resv.id },
                data: {
                  amount: (resvAmt - releaseAmt).toString(),
                },
              });
            }
            reservationToConsume -= releaseAmt;
          }
        }
      }

      // Update source GameAccount balance & reservedForOrders
      const account = await tx.gameAccount.findUnique({
        where: { id: params.accountId },
      });

      if (account) {
        const prevBalance = toBigInt(account.lastKnownBalance);
        const prevReserved = toBigInt(account.reservedForOrders);
        const nextBalance =
          params.postSendBalanceHint !== undefined
            ? params.postSendBalanceHint
            : prevBalance > params.chunkAmount
              ? prevBalance - params.chunkAmount
              : 0n;
        const nextReserved =
          prevReserved > consumedOnSourceAccount
            ? prevReserved - consumedOnSourceAccount
            : 0n;

        await tx.gameAccount.update({
          where: { id: account.id },
          data: {
            lastKnownBalance: nextBalance.toString(),
            reservedForOrders: nextReserved.toString(),
            lastSyncedAt: now,
            healthStatus: GameAccountHealth.ACTIVE,
          },
        });

        await tx.inventoryLedger.create({
          data: {
            gameAccountId: account.id,
            orderId: params.orderId,
            entryType: InventoryEntryType.DISBURSEMENT_DEBIT,
            deltaAmount: (-params.chunkAmount).toString(),
            balanceAfter: nextBalance.toString(),
            notes: `Disbursement chunk ${params.chunkId} delivered (${params.chunkAmount.toString()}).`,
            createdById: params.actorUserId ?? null,
          },
        });
      }

      // Recompute job progress from all chunks in DB
      const allJobChunks = await tx.disbursementChunk.findMany({
        where: { jobId: params.jobId },
      });
      const succeededChunks = allJobChunks.filter(
        (c) => c.status === DisbursementChunkStatus.SUCCEEDED
      );
      const deliveredJobAmount = succeededChunks.reduce(
        (sum, c) => sum + toBigInt(c.amount),
        0n
      );
      const completedChunksCount = succeededChunks.length;
      const allChunksSucceeded = completedChunksCount === allJobChunks.length;

      const job = await tx.disbursementJob.findUnique({
        where: { id: params.jobId },
      });

      const nextJobStatus = allChunksSucceeded
        ? DisbursementJobStatus.COMPLETED
        : job?.status === DisbursementJobStatus.PAUSED
          ? DisbursementJobStatus.PAUSED
          : DisbursementJobStatus.RUNNING;

      await tx.disbursementJob.update({
        where: { id: params.jobId },
        data: {
          deliveredAmount: deliveredJobAmount.toString(),
          completedChunks: completedChunksCount,
          status: nextJobStatus,
          completedAt: allChunksSucceeded ? now : null,
        },
      });

      // Update Order fulfilment progress
      const order = await tx.order.findUnique({
        where: { id: params.orderId },
      });

      if (order) {
        const prevFulfilled = toBigInt(order.fulfilledAmount);
        const requested = toBigInt(order.gameAmountRequested);
        const nextFulfilled = prevFulfilled + params.chunkAmount;
        const isOrderComplete = nextFulfilled >= requested;

        const nextOrderStatus = isOrderComplete
          ? OrderStatus.COMPLETED
          : OrderStatus.PARTIALLY_FULFILLED;

        await tx.order.update({
          where: { id: order.id },
          data: {
            gameAmountDelivered: nextFulfilled.toString(),
            fulfilledAmount: nextFulfilled.toString(),
            status: nextOrderStatus,
          },
        });

        if (isOrderComplete) {
          const cust = await tx.customer.findUnique({
            where: { id: order.customerId },
            select: { userId: true },
          });
          if (cust?.userId) {
            await tx.notification.create({
              data: {
                recipientUserId: cust.userId,
                type: NotificationType.ORDER_FULFILLED,
                orderId: order.id,
                title: `Order ${order.orderNumber} fulfilled`,
                message: `Your LagosLife currency order (${requested.toString()}) has been delivered to @${order.recipientLagoslifeUsername}.`,
              },
            });
          }
        }
      }

      await tx.auditLog.create({
        data: {
          actorUserId: params.actorUserId ?? null,
          actionType: "DISBURSEMENT_CHUNK_CONFIRMED",
          targetEntity: "disbursement_chunks",
          targetId: params.chunkId,
          afterState: {
            jobId: params.jobId,
            orderId: params.orderId,
            sourceAccountId: params.accountId,
            amount: params.chunkAmount.toString(),
            completedChunks: completedChunksCount,
            totalChunks: allJobChunks.length,
            reconciliationNote: params.reconciliationNote,
          },
          reason: params.reconciliationNote ?? "Disbursement chunk confirmed delivered.",
          ipAddress: params.ipAddress,
        },
      });
    });
  }

  private async pauseJobOnAccountError(
    jobId: string,
    chunkId: string,
    accountId: string,
    errorMessage: string,
    markSessionExpired: boolean
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (markSessionExpired) {
        await tx.gameAccount.update({
          where: { id: accountId },
          data: { healthStatus: GameAccountHealth.SESSION_EXPIRED },
        });
      }
      await tx.disbursementChunk.update({
        where: { id: chunkId },
        data: {
          status: DisbursementChunkStatus.FAILED_RETRYABLE,
          errorMessage,
        },
      });
      await tx.disbursementJob.update({
        where: { id: jobId },
        data: { status: DisbursementJobStatus.PAUSED },
      });
    });
  }

  /**
   * Pauses an active `DisbursementJob`. Any in-flight chunk completes its current step and halts.
   */
  async pauseJob(input: {
    jobId: string;
    actorUserId: string;
    actorRole: UserRole;
    reason?: string;
    ipAddress?: string;
  }): Promise<SerializedDisbursementJob> {
    if (input.actorRole !== UserRole.OWNER) {
      throw new DisbursementError(403, "FORBIDDEN", "Only the Owner can pause a disbursement job.");
    }

    const job = await this.prisma.disbursementJob.findUnique({
      where: { id: input.jobId },
    });
    if (!job) {
      throw new DisbursementError(404, "DISBURSEMENT_JOB_NOT_FOUND", "Disbursement job not found.");
    }

    if (
      job.status !== DisbursementJobStatus.PENDING &&
      job.status !== DisbursementJobStatus.RUNNING &&
      job.status !== DisbursementJobStatus.PAUSED
    ) {
      throw new DisbursementError(
        409,
        "JOB_CANNOT_BE_PAUSED",
        `Disbursement job in status ${job.status} cannot be paused.`
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.disbursementJob.update({
        where: { id: job.id },
        data: { status: DisbursementJobStatus.PAUSED },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "DISBURSEMENT_JOB_PAUSED",
          targetEntity: "disbursement_jobs",
          targetId: job.id,
          afterState: {
            orderId: job.orderId,
            status: DisbursementJobStatus.PAUSED,
          },
          reason: input.reason ?? "Paused by Owner.",
          ipAddress: input.ipAddress,
        },
      });
    });

    return this.getJobDetail(job.id);
  }

  /**
   * Resumes a `PAUSED` `DisbursementJob` once any `AMBIGUOUS_MANUAL_REVIEW` chunks have been resolved.
   */
  async resumeJob(input: {
    jobId: string;
    actorUserId: string;
    actorRole: UserRole;
    reason?: string;
    ipAddress?: string;
  }): Promise<SerializedDisbursementJob> {
    if (input.actorRole !== UserRole.OWNER) {
      throw new DisbursementError(403, "FORBIDDEN", "Only the Owner can resume a disbursement job.");
    }

    const job = await this.prisma.disbursementJob.findUnique({
      where: { id: input.jobId },
      include: { chunks: true },
    });
    if (!job) {
      throw new DisbursementError(404, "DISBURSEMENT_JOB_NOT_FOUND", "Disbursement job not found.");
    }

    if (job.status !== DisbursementJobStatus.PAUSED) {
      throw new DisbursementError(
        409,
        "JOB_NOT_PAUSED",
        `Disbursement job is in status ${job.status}, not PAUSED.`
      );
    }

    const unresolvedAmbiguous = job.chunks.find(
      (c) => c.status === DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW
    );
    if (unresolvedAmbiguous) {
      throw new DisbursementError(
        409,
        "AMBIGUOUS_CHUNK_UNRESOLVED",
        `Cannot resume job while chunk ${unresolvedAmbiguous.id} is still in AMBIGUOUS_MANUAL_REVIEW. Resolve it first.`
      );
    }

    const allSucceeded = job.chunks.every(
      (c) => c.status === DisbursementChunkStatus.SUCCEEDED
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.disbursementJob.update({
        where: { id: job.id },
        data: {
          status: allSucceeded
            ? DisbursementJobStatus.COMPLETED
            : DisbursementJobStatus.PENDING,
          completedAt: allSucceeded ? new Date() : null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "DISBURSEMENT_JOB_RESUMED",
          targetEntity: "disbursement_jobs",
          targetId: job.id,
          afterState: {
            orderId: job.orderId,
            status: allSucceeded
              ? DisbursementJobStatus.COMPLETED
              : DisbursementJobStatus.PENDING,
          },
          reason: input.reason ?? "Resumed by Owner.",
          ipAddress: input.ipAddress,
        },
      });
    });

    return this.getJobDetail(job.id);
  }

  /**
   * Cancels remaining unexecuted chunks on a `DisbursementJob`.
   * Preserves all already-delivered chunks (`PARTIAL` if `deliveredAmount > 0`, otherwise `FAILED`).
   */
  async cancelJob(input: {
    jobId: string;
    actorUserId: string;
    actorRole: UserRole;
    reason: string;
    ipAddress?: string;
  }): Promise<SerializedDisbursementJob> {
    if (input.actorRole !== UserRole.OWNER) {
      throw new DisbursementError(403, "FORBIDDEN", "Only the Owner can cancel a disbursement job.");
    }

    const job = await this.prisma.disbursementJob.findUnique({
      where: { id: input.jobId },
      include: { chunks: true },
    });
    if (!job) {
      throw new DisbursementError(404, "DISBURSEMENT_JOB_NOT_FOUND", "Disbursement job not found.");
    }

    if (job.status === DisbursementJobStatus.COMPLETED) {
      throw new DisbursementError(
        409,
        "JOB_ALREADY_COMPLETED",
        "Completed disbursement job cannot be cancelled."
      );
    }

    const unresolvedAmbiguous = job.chunks.find(
      (c) => c.status === DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW
    );
    if (unresolvedAmbiguous) {
      throw new DisbursementError(
        409,
        "AMBIGUOUS_CHUNK_UNRESOLVED",
        `Resolve ambiguous chunk ${unresolvedAmbiguous.id} before cancelling the job so inventory accounting stays exact.`
      );
    }

    const deliveredBig = toBigInt(job.deliveredAmount);

    await this.prisma.$transaction(async (tx) => {
      for (const chunk of job.chunks) {
        if (
          chunk.status === DisbursementChunkStatus.PENDING ||
          chunk.status === DisbursementChunkStatus.FAILED_RETRYABLE
        ) {
          await tx.disbursementChunk.update({
            where: { id: chunk.id },
            data: {
              status: DisbursementChunkStatus.FAILED_TERMINAL,
              errorMessage: `Cancelled by Owner: ${input.reason}`,
            },
          });
        }
      }

      const nextStatus =
        deliveredBig > 0n
          ? DisbursementJobStatus.PARTIAL
          : DisbursementJobStatus.FAILED;

      await tx.disbursementJob.update({
        where: { id: job.id },
        data: {
          status: nextStatus,
          completedAt: new Date(),
        },
      });

      const order = await tx.order.findUnique({ where: { id: job.orderId } });
      if (order && order.status !== OrderStatus.COMPLETED) {
        const fulfilledBig = toBigInt(order.fulfilledAmount);
        await tx.order.update({
          where: { id: order.id },
          data: {
            status:
              fulfilledBig > 0n
                ? OrderStatus.PARTIALLY_FULFILLED
                : OrderStatus.READY_FOR_FULFILMENT,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "DISBURSEMENT_JOB_CANCELLED",
          targetEntity: "disbursement_jobs",
          targetId: job.id,
          afterState: {
            orderId: job.orderId,
            deliveredAmount: deliveredBig.toString(),
            finalStatus: nextStatus,
          },
          reason: input.reason,
          ipAddress: input.ipAddress,
        },
      });
    });

    return this.getJobDetail(job.id);
  }

  /**
   * Resolves a chunk in `AMBIGUOUS_MANUAL_REVIEW` after Owner inspection:
   * - `CONFIRMED_DELIVERED`: commits transactional ledger debit, reservation consumption, and order fulfilment progress.
   * - `CONFIRMED_NOT_DELIVERED`: resets chunk to `PENDING` with a fresh idempotency key suffix so it can be safely re-sent when resumed.
   */
  async resolveAmbiguousChunk(
    input: ResolveAmbiguousChunkInput
  ): Promise<SerializedDisbursementJob> {
    if (input.actorRole !== UserRole.OWNER) {
      throw new DisbursementError(
        403,
        "FORBIDDEN",
        "Only the Owner can resolve an ambiguous disbursement chunk."
      );
    }

    const job = await this.prisma.disbursementJob.findUnique({
      where: { id: input.jobId },
      include: { chunks: true },
    });
    if (!job) {
      throw new DisbursementError(404, "DISBURSEMENT_JOB_NOT_FOUND", "Disbursement job not found.");
    }

    const chunk = job.chunks.find((c) => c.id === input.chunkId);
    if (!chunk) {
      throw new DisbursementError(
        404,
        "DISBURSEMENT_CHUNK_NOT_FOUND",
        "Disbursement chunk not found on this job."
      );
    }

    if (chunk.status !== DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW) {
      throw new DisbursementError(
        409,
        "CHUNK_NOT_AMBIGUOUS",
        `Chunk ${chunk.id} is in status ${chunk.status}, not AMBIGUOUS_MANUAL_REVIEW.`
      );
    }

    if (input.outcome === "CONFIRMED_DELIVERED") {
      await this.commitConfirmedChunkDelivery({
        jobId: job.id,
        orderId: job.orderId,
        chunkId: chunk.id,
        accountId: chunk.sourceAccountId,
        chunkAmount: toBigInt(chunk.amount),
        httpStatus: chunk.httpStatus ?? 200,
        reconciliationNote: `Owner manual review CONFIRMED_DELIVERED: ${input.notes}`,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress,
      });
    } else {
      const nextIdempotencyKey = `${chunk.idempotencyKey}_rev${chunk.attemptCount + 1}`;
      await this.prisma.$transaction(async (tx) => {
        await tx.disbursementChunk.update({
          where: { id: chunk.id },
          data: {
            status: DisbursementChunkStatus.PENDING,
            idempotencyKey: nextIdempotencyKey,
            errorMessage: null,
            reconciliationNote: `Owner manual review CONFIRMED_NOT_DELIVERED (queued for retry): ${input.notes}`,
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: input.actorUserId,
            actionType: "DISBURSEMENT_CHUNK_RESOLVED_NOT_DELIVERED",
            targetEntity: "disbursement_chunks",
            targetId: chunk.id,
            afterState: {
              jobId: job.id,
              orderId: job.orderId,
              nextIdempotencyKey,
            },
            reason: input.notes,
            ipAddress: input.ipAddress,
          },
        });
      });
    }

    return this.getJobDetail(job.id);
  }

  async getJobDetail(jobId: string): Promise<SerializedDisbursementJob> {
    const job = await this.prisma.disbursementJob.findUnique({
      where: { id: jobId },
      include: {
        chunks: {
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!job) {
      throw new DisbursementError(404, "DISBURSEMENT_JOB_NOT_FOUND", "Disbursement job not found.");
    }

    const accounts = await this.prisma.gameAccount.findMany();
    return this.serializeJob(job, job.chunks, accounts);
  }

  async getOrderDisbursementJobs(orderId: string): Promise<SerializedDisbursementJob[]> {
    const jobs = await this.prisma.disbursementJob.findMany({
      where: { orderId },
      include: {
        chunks: {
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const accounts = await this.prisma.gameAccount.findMany();
    return jobs.map((j) => this.serializeJob(j, j.chunks, accounts));
  }

  private serializeJob(
    job: {
      id: string;
      orderId: string;
      totalAmount: Prisma.Decimal | bigint;
      deliveredAmount: Prisma.Decimal | bigint;
      status: DisbursementJobStatus;
      totalChunks: number;
      completedChunks: number;
      startedAt: Date | null;
      completedAt: Date | null;
      createdAt: Date;
    },
    chunks: Array<{
      id: string;
      jobId: string;
      sourceAccountId: string;
      recipientUsername: string;
      amount: Prisma.Decimal | bigint;
      idempotencyKey: string;
      status: DisbursementChunkStatus;
      attemptCount: number;
      httpStatus: number | null;
      errorMessage: string | null;
      reconciliationNote: string | null;
      executedAt: Date | null;
      createdAt: Date;
    }>,
    accounts: Array<{
      id: string;
      slotCode: string;
      accountRole: string;
      lagoslifeUsername: string | null;
    }>
  ): SerializedDisbursementJob {
    const accountMap = new Map(accounts.map((a) => [a.id, a]));
    const totalBig = toBigInt(job.totalAmount);
    const deliveredBig = toBigInt(job.deliveredAmount);
    const remainingAmount = totalBig > deliveredBig ? totalBig - deliveredBig : 0n;
    const progressPercent =
      job.totalChunks > 0 ? Math.round((job.completedChunks / job.totalChunks) * 100) : 0;
    const hasAmbiguousChunks = chunks.some(
      (c) => c.status === DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW
    );

    return {
      id: job.id,
      orderId: job.orderId,
      totalAmount: totalBig.toString(),
      deliveredAmount: deliveredBig.toString(),
      remainingAmount: remainingAmount.toString(),
      status: job.status,
      totalChunks: job.totalChunks,
      completedChunks: job.completedChunks,
      progressPercent,
      hasAmbiguousChunks,
      startedAt: job.startedAt ? job.startedAt.toISOString() : null,
      completedAt: job.completedAt ? job.completedAt.toISOString() : null,
      createdAt: job.createdAt.toISOString(),
      chunks: chunks.map((c) => {
        const acc = accountMap.get(c.sourceAccountId);
        const decoded = decodeResolvedRecipient(c.recipientUsername);
        return {
          id: c.id,
          jobId: c.jobId,
          sourceAccountId: c.sourceAccountId,
          sourceSlotCode: acc?.slotCode ?? null,
          sourceAccountLabel: acc?.slotCode ?? null,
          sourceLagoslifeUsername: acc?.lagoslifeUsername ?? null,
          recipientUsername: decoded.username,
          resolvedTargetId: decoded.targetId,
          amount: toBigInt(c.amount).toString(),
          idempotencyKey: c.idempotencyKey,
          status: c.status,
          attemptCount: c.attemptCount,
          httpStatus: c.httpStatus,
          errorMessage: c.errorMessage,
          reconciliationNote: c.reconciliationNote,
          executedAt: c.executedAt ? c.executedAt.toISOString() : null,
          createdAt: c.createdAt.toISOString(),
        };
      }),
    };
  }
}

export { InventoryError };
