import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  CustomerCategory,
  DisbursementChunkStatus,
  DisbursementJobStatus,
  GameAccountHealth,
  GameAccountRole,
  InventoryEntryType,
  InventoryReservationStatus,
  OrderChannel,
  OrderStatus,
  OrderType,
  Prisma,
  RefundFinancialStatus,
  UserRole,
  type PrismaClient,
} from "@prisma/client";
import { buildApp } from "./app.js";
import type { AppEnv } from "./config/env.js";
import type { AuditLogEntryInput, AuditLogRecord, AuditLogStore } from "./lib/audit.js";
import { hashSessionToken } from "./lib/crypto.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import type { AuthStore, PlatformStore } from "./lib/repositories.js";
import {
  ACCOUNT_COOLDOWN_MS,
  DisbursementService,
  MAX_TRANSFER_CHUNK,
  splitAmountIntoChunks,
} from "./services/disbursement.js";
import {
  encodeEncryptedSessionBundle,
  LAGOSLIFE_SEND_COOLDOWN_MS,
  LagosLifeAdapter,
  MAX_LAGOSLIFE_TRANSFER_CHUNK,
} from "./services/lagoslife.js";
import { OperationsService } from "./services/operations.js";

const TEST_ENCRYPTION_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_SESSION_SECRET = "stage8b-test-session-secret-minimum-32-chars!!";

function dec(val: bigint | number | string): Prisma.Decimal {
  return new Prisma.Decimal(val.toString());
}

/**
 * 100% isolated in-memory harness for Stage 8B tests.
 * Never touches PostgreSQL, Redis, or live LagosLife endpoints.
 */
function createIsolatedStage8BHarness(options?: {
  fetchImpl?: typeof fetch;
  disbursementEnabled?: boolean;
  nowFn?: () => number;
}) {
  const ownerUserId = crypto.randomUUID();
  const customerUserId = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const ownerSessionId = crypto.randomUUID();
  const customerSessionId = crypto.randomUUID();

  const ownerToken = "stage8b_owner_raw_token";
  const customerToken = "stage8b_customer_raw_token";
  const ownerTokenHash = hashSessionToken(ownerToken, TEST_SESSION_SECRET);
  const customerTokenHash = hashSessionToken(customerToken, TEST_SESSION_SECRET);

  const slotDefs = [
    {
      slotCode: "MAIN_TREASURY",
      accountRole: GameAccountRole.MAIN_TREASURY,
      username: "bigola2823",
      uid: "6e3c4bdaac6f4765ba52",
      initialBalance: 100_000_000_000_000n, // 100T
    },
    {
      slotCode: "RESERVE_1",
      accountRole: GameAccountRole.RESERVE,
      username: "bigola_res1",
      uid: "res1_uid_1111111111",
      initialBalance: 70_000_000_000_000n, // 70T
    },
    {
      slotCode: "RESERVE_2",
      accountRole: GameAccountRole.RESERVE,
      username: "bigola_res2",
      uid: "res2_uid_2222222222",
      initialBalance: 70_000_000_000_000n, // 70T
    },
    {
      slotCode: "RESERVE_3",
      accountRole: GameAccountRole.RESERVE,
      username: "bigola_res3",
      uid: "res3_uid_3333333333",
      initialBalance: 70_000_000_000_000n, // 70T
    },
    {
      slotCode: "RESERVE_4",
      accountRole: GameAccountRole.RESERVE,
      username: "bigola_res4",
      uid: "res4_uid_4444444444",
      initialBalance: 70_000_000_000_000n, // 70T
    },
  ];

  const gameAccounts = new Map<
    string,
    {
      id: string;
      slotCode: string;
      accountRole: GameAccountRole;
      lagoslifeUsername: string | null;
      encryptedSessionBundle: string | null;
      lastKnownBalance: Prisma.Decimal;
      logicalAllocationAmount: Prisma.Decimal;
      reservedForOrders: Prisma.Decimal;
      targetReserveAmount: Prisma.Decimal;
      healthStatus: GameAccountHealth;
      lastSyncedAt: Date | null;
      cooldownUntil: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }
  >();

  for (const def of slotDefs) {
    const id = crypto.randomUUID();
    const encryptedSessionBundle = encodeEncryptedSessionBundle(
      {
        cookie: `ll_session=cookie_${def.slotCode.toLowerCase()}`,
        uid: def.uid,
        username: def.username,
        simName: def.slotCode,
        connectedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
      },
      TEST_ENCRYPTION_KEY_HEX
    );
    gameAccounts.set(id, {
      id,
      slotCode: def.slotCode,
      accountRole: def.accountRole,
      lagoslifeUsername: def.username,
      encryptedSessionBundle,
      lastKnownBalance: dec(def.initialBalance),
      logicalAllocationAmount: dec(def.initialBalance),
      reservedForOrders: dec(0n),
      targetReserveAmount: dec(70_000_000_000_000n),
      healthStatus: GameAccountHealth.ACTIVE,
      lastSyncedAt: new Date(),
      cooldownUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const orders = new Map<
    string,
    {
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
      fulfilledAmount: Prisma.Decimal;
      fiatAmountKobo: bigint;
      verifiedGrossFiatKobo: bigint;
      confirmedRefundedKobo: bigint;
      refundFinancialStatus: RefundFinancialStatus;
      status: OrderStatus;
      expiresAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }
  >();

  const reservations = new Map<
    string,
    {
      id: string;
      orderId: string;
      gameAccountId: string;
      amount: Prisma.Decimal;
      status: InventoryReservationStatus;
      expiresAt: Date | null;
      releasedAt: Date | null;
      createdAt: Date;
    }
  >();

  const disbursementJobs = new Map<
    string,
    {
      id: string;
      orderId: string;
      totalAmount: Prisma.Decimal;
      deliveredAmount: Prisma.Decimal;
      status: DisbursementJobStatus;
      totalChunks: number;
      completedChunks: number;
      startedAt: Date | null;
      completedAt: Date | null;
      createdAt: Date;
    }
  >();

  const disbursementChunks = new Map<
    string,
    {
      id: string;
      jobId: string;
      sourceAccountId: string;
      recipientUsername: string;
      amount: Prisma.Decimal;
      idempotencyKey: string;
      status: DisbursementChunkStatus;
      attemptCount: number;
      httpStatus: number | null;
      errorMessage: string | null;
      reconciliationNote: string | null;
      executedAt: Date | null;
      createdAt: Date;
    }
  >();

  const inventoryLedgers: Array<{
    id: string;
    gameAccountId: string;
    orderId: string | null;
    entryType: InventoryEntryType;
    deltaAmount: Prisma.Decimal;
    balanceAfter: Prisma.Decimal;
    notes: string | null;
    createdById: string | null;
    createdAt: Date;
  }> = [];

  const auditLogs: AuditLogRecord[] = [];
  const notifications: Array<Record<string, unknown>> = [];

  function createOrderFixture(params: {
    recipientLagoslifeUsername: string;
    gameAmountRequested: bigint;
    status: OrderStatus;
    reserveOnSlot?: string;
  }) {
    const id = crypto.randomUUID();
    const order = {
      id,
      orderNumber: `ORD-8B-${orders.size + 1}`,
      paymentReference: `BGL-8B-${orders.size + 1}`,
      channel: OrderChannel.ONLINE,
      orderType: OrderType.BULK,
      customerId,
      customerCategory: CustomerCategory.DIRECT,
      partnerId: null,
      recipientLagoslifeUsername: params.recipientLagoslifeUsername,
      gameAmountRequested: dec(params.gameAmountRequested),
      fulfilledAmount: dec(0n),
      fiatAmountKobo: 50_000_000n,
      verifiedGrossFiatKobo:
        params.status === OrderStatus.AWAITING_PAYMENT ? 0n : 50_000_000n,
      confirmedRefundedKobo: 0n,
      refundFinancialStatus: RefundFinancialStatus.NONE,
      status: params.status,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    orders.set(id, order);

    if (params.reserveOnSlot) {
      const slotAcc = Array.from(gameAccounts.values()).find(
        (a) => a.slotCode === params.reserveOnSlot
      );
      if (slotAcc) {
        const resvId = crypto.randomUUID();
        reservations.set(resvId, {
          id: resvId,
          orderId: id,
          gameAccountId: slotAcc.id,
          amount: dec(params.gameAmountRequested),
          status: InventoryReservationStatus.ACTIVE,
          expiresAt: null,
          releasedAt: null,
          createdAt: new Date(),
        });
        const curResv = BigInt(slotAcc.reservedForOrders.toFixed(0));
        slotAcc.reservedForOrders = dec(curResv + params.gameAmountRequested);
      }
    }

    return order;
  }

  const mockPrisma: Record<string, unknown> = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma),
    gameAccount: {
      findMany: async () => Array.from(gameAccounts.values()),
      findUnique: async ({ where }: { where: { id?: string; slotCode?: string } }) => {
        if (where.id) return gameAccounts.get(where.id) ?? null;
        if (where.slotCode) {
          return (
            Array.from(gameAccounts.values()).find((a) => a.slotCode === where.slotCode) ?? null
          );
        }
        return null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const acc = gameAccounts.get(where.id);
        if (!acc) throw new Error("GameAccount not found");
        if (data.lastKnownBalance !== undefined) {
          acc.lastKnownBalance = dec(String(data.lastKnownBalance));
        }
        if (data.reservedForOrders !== undefined) {
          acc.reservedForOrders = dec(String(data.reservedForOrders));
        }
        if (data.healthStatus !== undefined) {
          acc.healthStatus = data.healthStatus as GameAccountHealth;
        }
        if (data.lastSyncedAt !== undefined) {
          acc.lastSyncedAt = data.lastSyncedAt as Date | null;
        }
        acc.updatedAt = new Date();
        return acc;
      },
    },
    order: {
      findUnique: async ({
        where,
        include,
      }: {
        where: { id: string };
        include?: Record<string, unknown>;
      }) => {
        const o = orders.get(where.id);
        if (!o) return null;
        const result: Record<string, unknown> = { ...o };
        if (include?.reservations) {
          result.reservations = Array.from(reservations.values()).filter(
            (r) => r.orderId === o.id && r.status === InventoryReservationStatus.ACTIVE
          );
        }
        if (include?.disbursementJobs) {
          const jobs = Array.from(disbursementJobs.values())
            .filter((j) => j.orderId === o.id)
            .map((j) => ({
              ...j,
              chunks: Array.from(disbursementChunks.values()).filter((c) => c.jobId === j.id),
            }));
          result.disbursementJobs = jobs;
        }
        return result;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const o = orders.get(where.id);
        if (!o) throw new Error("Order not found");
        if (data.status !== undefined) o.status = data.status as OrderStatus;
        if (data.fulfilledAmount !== undefined) {
          o.fulfilledAmount = dec(String(data.fulfilledAmount));
        }
        o.updatedAt = new Date();
        return o;
      },
    },
    inventoryReservation: {
      findMany: async ({
        where,
      }: {
        where: { orderId: string; status?: InventoryReservationStatus };
      }) => {
        return Array.from(reservations.values()).filter(
          (r) =>
            r.orderId === where.orderId &&
            (where.status === undefined || r.status === where.status)
        );
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const r = reservations.get(where.id);
        if (!r) throw new Error("Reservation not found");
        if (data.amount !== undefined) r.amount = dec(String(data.amount));
        if (data.status !== undefined) r.status = data.status as InventoryReservationStatus;
        if (data.releasedAt !== undefined) r.releasedAt = data.releasedAt as Date | null;
        return r;
      },
    },
    inventoryLedger: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const entry = {
          id: crypto.randomUUID(),
          gameAccountId: String(data.gameAccountId),
          orderId: (data.orderId as string) ?? null,
          entryType: data.entryType as InventoryEntryType,
          deltaAmount: dec(String(data.deltaAmount)),
          balanceAfter: dec(String(data.balanceAfter)),
          notes: (data.notes as string) ?? null,
          createdById: (data.createdById as string) ?? null,
          createdAt: new Date(),
        };
        inventoryLedgers.push(entry);
        return entry;
      },
    },
    disbursementJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const job = {
          id: crypto.randomUUID(),
          orderId: String(data.orderId),
          totalAmount: dec(String(data.totalAmount)),
          deliveredAmount: dec(String(data.deliveredAmount ?? "0")),
          status: data.status as DisbursementJobStatus,
          totalChunks: Number(data.totalChunks),
          completedChunks: Number(data.completedChunks ?? 0),
          startedAt: (data.startedAt as Date) ?? null,
          completedAt: (data.completedAt as Date) ?? null,
          createdAt: new Date(),
        };
        disbursementJobs.set(job.id, job);
        return job;
      },
      findUnique: async ({
        where,
        include,
      }: {
        where: { id: string };
        include?: Record<string, unknown>;
      }) => {
        const job = disbursementJobs.get(where.id);
        if (!job) return null;
        if (include?.chunks) {
          return {
            ...job,
            chunks: Array.from(disbursementChunks.values()).filter((c) => c.jobId === job.id),
          };
        }
        return job;
      },
      findMany: async ({ where }: { where: { orderId: string } }) => {
        return Array.from(disbursementJobs.values())
          .filter((j) => j.orderId === where.orderId)
          .map((j) => ({
            ...j,
            chunks: Array.from(disbursementChunks.values()).filter((c) => c.jobId === j.id),
          }));
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const job = disbursementJobs.get(where.id);
        if (!job) throw new Error("DisbursementJob not found");
        if (data.status !== undefined) job.status = data.status as DisbursementJobStatus;
        if (data.deliveredAmount !== undefined) {
          job.deliveredAmount = dec(String(data.deliveredAmount));
        }
        if (data.completedChunks !== undefined) {
          job.completedChunks = Number(data.completedChunks);
        }
        if (data.startedAt !== undefined) job.startedAt = data.startedAt as Date | null;
        if (data.completedAt !== undefined) job.completedAt = data.completedAt as Date | null;
        return job;
      },
    },
    disbursementChunk: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const chunk = {
          id: crypto.randomUUID(),
          jobId: String(data.jobId),
          sourceAccountId: String(data.sourceAccountId),
          recipientUsername: String(data.recipientUsername),
          amount: dec(String(data.amount)),
          idempotencyKey: String(data.idempotencyKey),
          status: data.status as DisbursementChunkStatus,
          attemptCount: Number(data.attemptCount ?? 0),
          httpStatus: (data.httpStatus as number) ?? null,
          errorMessage: (data.errorMessage as string) ?? null,
          reconciliationNote: (data.reconciliationNote as string) ?? null,
          executedAt: (data.executedAt as Date) ?? null,
          createdAt: new Date(),
        };
        disbursementChunks.set(chunk.id, chunk);
        return chunk;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        return disbursementChunks.get(where.id) ?? null;
      },
      findMany: async ({ where }: { where: { jobId: string } }) => {
        return Array.from(disbursementChunks.values()).filter((c) => c.jobId === where.jobId);
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const chunk = disbursementChunks.get(where.id);
        if (!chunk) throw new Error("DisbursementChunk not found");
        if (data.status !== undefined) chunk.status = data.status as DisbursementChunkStatus;
        if (data.idempotencyKey !== undefined) {
          chunk.idempotencyKey = String(data.idempotencyKey);
        }
        if (data.attemptCount !== undefined) {
          const ac = data.attemptCount as { increment?: number } | number;
          if (typeof ac === "object" && ac && typeof ac.increment === "number") {
            chunk.attemptCount += ac.increment;
          } else if (typeof ac === "number") {
            chunk.attemptCount = ac;
          }
        }
        if (data.httpStatus !== undefined) chunk.httpStatus = data.httpStatus as number | null;
        if (data.errorMessage !== undefined) {
          chunk.errorMessage = data.errorMessage as string | null;
        }
        if (data.reconciliationNote !== undefined) {
          chunk.reconciliationNote = data.reconciliationNote as string | null;
        }
        if (data.executedAt !== undefined) chunk.executedAt = data.executedAt as Date | null;
        return chunk;
      },
    },
    customer: {
      findUnique: async ({ where }: { where: { id?: string; userId?: string } }) => {
        if (where.id === customerId || where.userId === customerUserId) {
          return {
            id: customerId,
            userId: customerUserId,
            fullName: "Stage 8B Test Customer",
            email: "customer8b@bigola.local",
            phone: "+2348000000088",
            lagoslifeUsername: "milespete",
            category: CustomerCategory.DIRECT,
            attributedPartnerId: null,
          };
        }
        return null;
      },
    },
    notification: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        notifications.push(data);
        return { id: crypto.randomUUID(), ...data };
      },
    },
    auditLog: {
      create: async ({ data }: { data: AuditLogEntryInput }) => {
        const rec: AuditLogRecord = {
          id: crypto.randomUUID(),
          actorUserId: data.actorUserId ?? null,
          actionType: data.actionType,
          targetEntity: data.targetEntity,
          targetId: data.targetId ?? null,
          beforeState: data.beforeState ?? null,
          afterState: data.afterState ?? null,
          reason: data.reason ?? null,
          ipAddress: data.ipAddress ?? null,
          createdAt: new Date(),
        };
        auditLogs.push(rec);
        return rec;
      },
    },
  };

  const ownerUserRecord = {
    id: ownerUserId,
    email: "owner@bigola.local",
    phone: null,
    passwordHash: "unused",
    role: UserRole.OWNER,
    isActive: true,
    mfaEnabled: true,
    encryptedTotpSecret: null,
    recoveryCodeHashes: null,
  };

  const customerUserRecord = {
    id: customerUserId,
    email: "customer8b@bigola.local",
    phone: "+2348000000088",
    passwordHash: "unused",
    role: UserRole.CUSTOMER,
    isActive: true,
    mfaEnabled: false,
    encryptedTotpSecret: null,
    recoveryCodeHashes: null,
  };

  const authStore: AuthStore = {
    findUserByEmail: async () => null,
    findUserById: async (id) => {
      if (id === ownerUserId) return ownerUserRecord;
      if (id === customerUserId) return customerUserRecord;
      return null;
    },
    createUser: async () => {
      throw new Error("Unused in test");
    },
    updateUserMfa: async () => {},
    createSession: async () => {
      throw new Error("Unused in test");
    },
    findSessionByTokenHash: async (th) => {
      if (th === ownerTokenHash) {
        return {
          id: ownerSessionId,
          userId: ownerUserId,
          tokenHash: ownerTokenHash,
          mfaVerified: true,
          ipAddress: "127.0.0.1",
          userAgent: "stage8b-test",
          expiresAt: new Date(Date.now() + 3600_000),
          revokedAt: null,
          user: ownerUserRecord,
        };
      }
      if (th === customerTokenHash) {
        return {
          id: customerSessionId,
          userId: customerUserId,
          tokenHash: customerTokenHash,
          mfaVerified: false,
          ipAddress: "127.0.0.1",
          userAgent: "stage8b-test",
          expiresAt: new Date(Date.now() + 3600_000),
          revokedAt: null,
          user: customerUserRecord,
        };
      }
      return null;
    },
    markSessionMfaVerified: async () => {},
    revokeSession: async () => {},
  };

  const auditStore: AuditLogStore = {
    create: async (entry) => {
      const rec: AuditLogRecord = {
        id: crypto.randomUUID(),
        ...entry,
        createdAt: new Date(),
      };
      auditLogs.push(rec);
      return rec;
    },
    listRecent: async () => auditLogs,
  };

  const platformStore: PlatformStore = {
    getSettings: async () => [],
    upsertSetting: async (key, value, updatedById) => ({
      key,
      value,
      updatedById,
      updatedAt: new Date(),
    }),
    getGameAccounts: async () => [],
    getCommissionRules: async () => [],
  };

  const env: AppEnv = {
    NODE_ENV: "test",
    API_PORT: 0,
    API_HOST: "127.0.0.1",
    WEB_BASE_URL: "http://localhost:3000",
    ALLOWED_ORIGINS: "http://localhost:3000",
    allowedOrigins: ["http://localhost:3000"],
    DATABASE_URL: "",
    REDIS_URL: "",
    SESSION_SECRET: TEST_SESSION_SECRET,
    ENCRYPTION_KEY_HEX: TEST_ENCRYPTION_KEY_HEX,
    SESSION_TTL_HOURS: 24,
    OWNER_REQUIRE_2FA: true,
    DISBURSEMENT_ENABLED: options?.disbursementEnabled ?? false,
    QUEUE_PREFIX: "bigola-test-8b",
  };

  const adapter = new LagosLifeAdapter({
    fetchImpl: options?.fetchImpl,
  });

  const disbursementService = new DisbursementService(
    mockPrisma as unknown as PrismaClient,
    TEST_ENCRYPTION_KEY_HEX,
    adapter,
    {
      disbursementEnabled: options?.disbursementEnabled ?? false,
      nowFn: options?.nowFn,
      sleepFn: async () => {},
    }
  );

  const mockOperationsService = {
    getOrderOperationalDetail: async (orderId: string) => {
      const o = orders.get(orderId);
      if (!o) throw new Error("Order not found");
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        paymentReference: o.paymentReference,
        channel: o.channel,
        orderType: o.orderType,
        status: o.status,
        refundFinancialStatus: o.refundFinancialStatus,
        recipientLagoslifeUsername: o.recipientLagoslifeUsername,
        gameAmountRequested: o.gameAmountRequested.toFixed(0),
        fulfilledAmount: o.fulfilledAmount.toFixed(0),
        remainingFulfilmentAmount: BigInt(
          o.gameAmountRequested.sub(o.fulfilledAmount).toFixed(0)
        ).toString(),
        fiatAmountKobo: o.fiatAmountKobo.toString(),
        verifiedGrossFiatKobo: o.verifiedGrossFiatKobo.toString(),
        confirmedRefundedKobo: o.confirmedRefundedKobo.toString(),
        remainingRefundableKobo: o.verifiedGrossFiatKobo.toString(),
        createdAt: o.createdAt.toISOString(),
        customer: {
          id: customerId,
          fullName: "Stage 8B Test Customer",
          email: "customer8b@bigola.local",
          phone: "+2348000000088",
          lagoslifeUsername: "milespete",
          category: "DIRECT",
        },
        partner: null,
        reservations: [],
        fulfilmentRecords: [],
        refundRequests: [],
      };
    },
  } as unknown as OperationsService;

  return {
    env,
    authStore,
    auditStore,
    platformStore,
    prisma: mockPrisma as unknown as PrismaClient,
    disbursementService,
    operationsService: mockOperationsService,
    ownerUserId,
    ownerToken,
    customerToken,
    gameAccounts,
    orders,
    reservations,
    disbursementJobs,
    disbursementChunks,
    inventoryLedgers,
    auditLogs,
    createOrderFixture,
  };
}

test("Stage 8B.1: Preserves 100B max chunk, 30.5s cooldown, explicit Owner authorization, and 5-account split fulfilment", async () => {
  assert.equal(MAX_TRANSFER_CHUNK, 100_000_000_000n);
  assert.equal(MAX_LAGOSLIFE_TRANSFER_CHUNK, 100_000_000_000n);
  assert.equal(ACCOUNT_COOLDOWN_MS, 30_500);
  assert.equal(LAGOSLIFE_SEND_COOLDOWN_MS, 30_500);

  // Verify 250B splits into [100B, 100B, 50B]
  const split250B = splitAmountIntoChunks(250_000_000_000n);
  assert.deepEqual(split250B, [100_000_000_000n, 100_000_000_000n, 50_000_000_000n]);

  let currentNowMs = 1_700_000_000_000;
  const sentRequests: Array<{
    cookie: string;
    to: string;
    amount: number;
    idempotencyKey: string;
  }> = [];

  // Track live balances in mocked LagosLife /api/save
  const liveBalancesByCookie = new Map<string, bigint>([
    ["ll_session=cookie_main_treasury", 100_000_000_000_000n],
    ["ll_session=cookie_reserve_1", 70_000_000_000_000n],
    ["ll_session=cookie_reserve_2", 70_000_000_000_000n],
    ["ll_session=cookie_reserve_3", 70_000_000_000_000n],
    ["ll_session=cookie_reserve_4", 70_000_000_000_000n],
  ]);

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const cookie = headers.get("cookie") ?? "";

    if (url.endsWith("/api/save")) {
      const bal = liveBalancesByCookie.get(cookie) ?? 100_000_000_000_000n;
      return new Response(
        JSON.stringify({
          game: {
            money: Number(bal),
            sim: { name: "BigOlaSlot" },
            owner: "uid_test",
          },
          money: Number(bal),
          name: "BigOlaSlot",
          ownerUid: "uid_test",
          state: {
            money: Number(bal),
            name: "BigOlaSlot",
            sim: {
              money: Number(bal),
              name: "BigOlaSlot",
            },
          },
          sim: {
            money: Number(bal),
            name: "BigOlaSlot",
          },
          save: {
            money: Number(bal),
            name: "BigOlaSlot",
            ownerUid: "uid_test",
            sim: {
              money: Number(bal),
              name: "BigOlaSlot",
            },
            state: {
              money: Number(bal),
              name: "BigOlaSlot",
              sim: {
                money: Number(bal),
                name: "BigOlaSlot",
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (url.endsWith("/api/send")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { to: string; amount: number };
      const idemKey = headers.get("idempotency-key") ?? "";
      sentRequests.push({
        cookie,
        to: body.to,
        amount: body.amount,
        idempotencyKey: idemKey,
      });
      const prev = liveBalancesByCookie.get(cookie) ?? 0n;
      liveBalancesByCookie.set(cookie, prev - BigInt(body.amount));
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  };

  const harness = createIsolatedStage8BHarness({
    fetchImpl: mockFetch,
    disbursementEnabled: false, // Start with safety gate disabled
    nowFn: () => currentNowMs,
  });
  const queues = createQueueInfrastructure("", "bigola-test-8b-1");
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  try {
    app = await buildApp({
      env: harness.env,
      authStore: harness.authStore,
      auditStore: harness.auditStore,
      platformStore: harness.platformStore,
      queues,
      prisma: harness.prisma,
      disbursementService: harness.disbursementService,
      operationsService: harness.operationsService,
      checkDb: async () => true,
    });

    // 1. Unverified order (AWAITING_PAYMENT) cannot be authorized for disbursement
    const unpaidOrder = harness.createOrderFixture({
      recipientLagoslifeUsername: "milespete",
      gameAmountRequested: 200_000_000_000n,
      status: OrderStatus.AWAITING_PAYMENT,
    });

    const unpaidAuthRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${unpaidOrder.id}/disbursements/authorize`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {
        allocations: [{ slotCode: "MAIN_TREASURY", amount: "200000000000" }],
      },
    });
    assert.equal(unpaidAuthRes.statusCode, 409);
    assert.equal(unpaidAuthRes.json().code, "ORDER_NOT_READY_FOR_FULFILMENT");

    // 2. Payment-verified order (READY_FOR_FULFILMENT) has 0 automatic jobs until Owner authorizes
    // Order for 650B split across all 5 accounts:
    // MAIN_TREASURY: 250B (3 chunks: 100B, 100B, 50B)
    // RESERVE_1: 100B (1 chunk)
    // RESERVE_2: 100B (1 chunk)
    // RESERVE_3: 100B (1 chunk)
    // RESERVE_4: 100B (1 chunk)
    // Total = 650B across 7 chunks
    const verifiedOrder = harness.createOrderFixture({
      recipientLagoslifeUsername: "milespete",
      gameAmountRequested: 650_000_000_000n,
      status: OrderStatus.READY_FOR_FULFILMENT,
      reserveOnSlot: "MAIN_TREASURY",
    });

    assert.equal(harness.disbursementJobs.size, 0);

    const authRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${verifiedOrder.id}/disbursements/authorize`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {
        allocations: [
          { slotCode: "MAIN_TREASURY", amount: "250000000000" },
          { slotCode: "RESERVE_1", amount: "100000000000" },
          { slotCode: "RESERVE_2", amount: "100000000000" },
          { slotCode: "RESERVE_3", amount: "100000000000" },
          { slotCode: "RESERVE_4", amount: "100000000000" },
        ],
        authorizationNote: "Split across all 5 accounts",
      },
    });

    assert.equal(authRes.statusCode, 201);
    const authorizedJob = authRes.json().job;
    assert.equal(authorizedJob.status, "PENDING");
    assert.equal(authorizedJob.totalAmount, "650000000000");
    assert.equal(authorizedJob.totalChunks, 7);
    assert.equal(authorizedJob.completedChunks, 0);

    // Verify recipient @milespete was resolved to exact targetId bc745837935d45efbf47 before execution
    for (const chunk of authorizedJob.chunks) {
      assert.equal(chunk.recipientUsername, "milespete");
      assert.equal(chunk.resolvedTargetId, "bc745837935d45efbf47");
      assert.ok(BigInt(chunk.amount) <= 100_000_000_000n);
    }

    // 3. While DISBURSEMENT_ENABLED=false, execution is blocked with 409 DISBURSEMENT_DISABLED
    const blockedExecRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${authorizedJob.id}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {},
    });
    assert.equal(blockedExecRes.statusCode, 409);
    assert.equal(blockedExecRes.json().code, "DISBURSEMENT_DISABLED");
    assert.equal(sentRequests.length, 0);

    // 4. Enable disbursement for controlled test execution and run first pass (without waiting cooldown)
    harness.disbursementService.setDisbursementEnabledForTesting(true);

    // In pass 1 (at t = currentNowMs), 1 chunk per distinct ready account can execute immediately (5 accounts = 5 chunks:
    // 100B from MAIN_TREASURY + 100B from each of RESERVE_1..4 = 500B delivered!),
    // while MAIN_TREASURY's 2nd and 3rd chunks wait for MAIN_TREASURY's 30.5s cooldown!
    const execPass1Res = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${authorizedJob.id}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { waitForCooldown: false },
    });
    assert.equal(execPass1Res.statusCode, 200);
    const jobAfterPass1 = execPass1Res.json().job;
    assert.equal(jobAfterPass1.completedChunks, 5);
    assert.equal(jobAfterPass1.deliveredAmount, "500000000000");
    assert.equal(jobAfterPass1.status, "RUNNING");
    assert.equal(harness.orders.get(verifiedOrder.id)?.status, OrderStatus.PARTIALLY_FULFILLED);

    // Verify MAIN_TREASURY has active 30.5s cooldown (30,500ms)
    const mainAcc = Array.from(harness.gameAccounts.values()).find(
      (a) => a.slotCode === "MAIN_TREASURY"
    )!;
    const remCooldown = await harness.disbursementService.coordinator.getRemainingCooldownMs(
      mainAcc.id
    );
    assert.equal(remCooldown, 30_500);

    // Advance clock by 30.5s (30,500ms) -> 2nd chunk from MAIN_TREASURY (100B) executes
    currentNowMs += 30_500;
    const execPass2Res = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${authorizedJob.id}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { waitForCooldown: false },
    });
    assert.equal(execPass2Res.statusCode, 200);
    assert.equal(execPass2Res.json().job.completedChunks, 6);
    assert.equal(execPass2Res.json().job.deliveredAmount, "600000000000");

    // Advance clock by another 30.5s -> 3rd chunk from MAIN_TREASURY (50B) executes and completes the order!
    currentNowMs += 30_500;
    const execPass3Res = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${authorizedJob.id}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { waitForCooldown: false },
    });
    assert.equal(execPass3Res.statusCode, 200);
    const completedJob = execPass3Res.json().job;
    assert.equal(completedJob.status, "COMPLETED");
    assert.equal(completedJob.completedChunks, 7);
    assert.equal(completedJob.deliveredAmount, "650000000000");
    assert.equal(completedJob.progressPercent, 100);

    // Verify order is COMPLETED and inventory ledger has 7 DISBURSEMENT_DEBIT entries totaling -650B
    const finalOrder = harness.orders.get(verifiedOrder.id)!;
    assert.equal(finalOrder.status, OrderStatus.COMPLETED);
    assert.equal(finalOrder.fulfilledAmount.toFixed(0), "650000000000");
    assert.equal(harness.inventoryLedgers.length, 7);

    // Verify Customer progress endpoint returns full progress and zero raw cookies/secrets
    const custProgRes = await app.inject({
      method: "GET",
      url: `/api/v1/customer/orders/${verifiedOrder.id}/disbursements`,
      headers: { authorization: `Bearer ${harness.customerToken}` },
    });
    assert.equal(custProgRes.statusCode, 200);
    const custBody = custProgRes.json();
    assert.equal(custBody.orderStatus, "COMPLETED");
    assert.equal(custBody.fulfilledAmount, "650000000000");
    assert.equal(custBody.jobs[0].progressPercent, 100);
    assert.ok(!JSON.stringify(custBody).includes("ll_session="));
  } finally {
    if (app) await app.close();
    await queues.close();
  }
});

test("Stage 8B.2: Duplicate-transfer prevention, /api/save balance-delta reconciliation, and AMBIGUOUS_MANUAL_REVIEW Owner resolution", async () => {
  let currentNowMs = 1_700_000_100_000;
  let mainTreasuryLiveBalance = 100_000_000_000_000n; // 100T
  let sendBehavior: "UNCERTAIN_BUT_DEBITED" | "UNCERTAIN_NOT_DEBITED" | "UNCERTAIN_AND_SAVE_FAILS" =
    "UNCERTAIN_BUT_DEBITED";
  let failPostSave = false;

  const mockFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/api/save")) {
      if (failPostSave) {
        return new Response("Upstream gateway timeout", { status: 504 });
      }
      return new Response(
        JSON.stringify({
          game: {
            money: Number(mainTreasuryLiveBalance),
            sim: { name: "MainTreasury" },
            owner: "6e3c4bdaac6f4765ba52",
          },
          money: Number(mainTreasuryLiveBalance),
          name: "MainTreasury",
          ownerUid: "6e3c4bdaac6f4765ba52",
          state: {
            money: Number(mainTreasuryLiveBalance),
            name: "MainTreasury",
            sim: {
              money: Number(mainTreasuryLiveBalance),
              name: "MainTreasury",
            },
          },
          sim: {
            money: Number(mainTreasuryLiveBalance),
            name: "MainTreasury",
          },
          save: {
            money: Number(mainTreasuryLiveBalance),
            name: "MainTreasury",
            ownerUid: "6e3c4bdaac6f4765ba52",
            sim: {
              money: Number(mainTreasuryLiveBalance),
              name: "MainTreasury",
            },
            state: {
              money: Number(mainTreasuryLiveBalance),
              name: "MainTreasury",
              sim: {
                money: Number(mainTreasuryLiveBalance),
                name: "MainTreasury",
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (url.endsWith("/api/send")) {
      if (sendBehavior === "UNCERTAIN_BUT_DEBITED") {
        // Upstream debited 100B, but HTTP response dropped with 502 Bad Gateway
        mainTreasuryLiveBalance -= 100_000_000_000n;
        return new Response("Bad Gateway", { status: 502 });
      }
      if (sendBehavior === "UNCERTAIN_NOT_DEBITED") {
        // Upstream timed out before debiting balance
        throw new Error("Socket hang up during /api/send");
      }
      if (sendBehavior === "UNCERTAIN_AND_SAVE_FAILS") {
        // Uncertain 500 AND subsequent /api/save check fails
        failPostSave = true;
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    return new Response("{}", { status: 200 });
  };

  const harness = createIsolatedStage8BHarness({
    fetchImpl: mockFetch,
    disbursementEnabled: true,
    nowFn: () => currentNowMs,
  });
  const queues = createQueueInfrastructure("", "bigola-test-8b-2");
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  try {
    app = await buildApp({
      env: harness.env,
      authStore: harness.authStore,
      auditStore: harness.auditStore,
      platformStore: harness.platformStore,
      queues,
      prisma: harness.prisma,
      disbursementService: harness.disbursementService,
      operationsService: harness.operationsService,
      checkDb: async () => true,
    });

    // Create 200B order (2 chunks of 100B on MAIN_TREASURY)
    const order = harness.createOrderFixture({
      recipientLagoslifeUsername: "milespete",
      gameAmountRequested: 200_000_000_000n,
      status: OrderStatus.READY_FOR_FULFILMENT,
      reserveOnSlot: "MAIN_TREASURY",
    });

    const authRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${order.id}/disbursements/authorize`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {
        allocations: [{ slotCode: "MAIN_TREASURY", amount: "200000000000" }],
      },
    });
    assert.equal(authRes.statusCode, 201);
    const job = authRes.json().job;
    assert.equal(job.totalChunks, 2);

    // 1. Chunk 1 returns HTTP 502, but live /api/save shows balance dropped by 100B -> Reconciled as SUCCEEDED!
    sendBehavior = "UNCERTAIN_BUT_DEBITED";
    const step1 = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${job.id}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { maxChunksToProcess: 1 },
    });
    assert.equal(step1.statusCode, 200);
    const jobAfterStep1 = step1.json().job;
    assert.equal(jobAfterStep1.completedChunks, 1);
    assert.equal(jobAfterStep1.deliveredAmount, "100000000000");
    assert.equal(jobAfterStep1.chunks[0].status, "SUCCEEDED");
    assert.match(jobAfterStep1.chunks[0].reconciliationNote, /Reconciled as DELIVERED/);

    // 2. Advance 30.5s cooldown; Chunk 2 throws network timeout, and live /api/save shows balance unchanged -> FAILED_RETRYABLE
    currentNowMs += 30_500;
    sendBehavior = "UNCERTAIN_NOT_DEBITED";
    const step2 = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${job.id}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { maxChunksToProcess: 1 },
    });
    assert.equal(step2.statusCode, 200);
    const jobAfterStep2 = step2.json().job;
    assert.equal(jobAfterStep2.completedChunks, 1);
    assert.equal(jobAfterStep2.chunks[1].status, "FAILED_RETRYABLE");
    assert.match(jobAfterStep2.chunks[1].reconciliationNote, /Reconciled as NOT SENT/);

    // 3. Advance 30.5s cooldown; Chunk 2 returns HTTP 500 AND post-send /api/save fails -> AMBIGUOUS_MANUAL_REVIEW & Job PAUSED!
    currentNowMs += 30_500;
    sendBehavior = "UNCERTAIN_AND_SAVE_FAILS";
    const step3 = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${job.id}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { maxChunksToProcess: 1 },
    });
    assert.equal(step3.statusCode, 200);
    const jobAfterStep3 = step3.json().job;
    assert.equal(jobAfterStep3.status, "PAUSED");
    assert.equal(jobAfterStep3.hasAmbiguousChunks, true);
    assert.equal(jobAfterStep3.chunks[1].status, "AMBIGUOUS_MANUAL_REVIEW");

    // 4. Attempting to resume while chunk is still AMBIGUOUS_MANUAL_REVIEW is blocked with 409
    const blockedResume = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${job.id}/resume`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { reason: "Try resume before resolving" },
    });
    assert.equal(blockedResume.statusCode, 409);
    assert.equal(blockedResume.json().code, "AMBIGUOUS_CHUNK_UNRESOLVED");

    // 5. Owner resolves ambiguous chunk 2 as CONFIRMED_DELIVERED -> job & order complete transactionally!
    const resolveRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${job.id}/chunks/${jobAfterStep3.chunks[1].id}/resolve`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {
        outcome: "CONFIRMED_DELIVERED",
        notes: "Verified receipt with customer and LagosLife history",
      },
    });
    assert.equal(resolveRes.statusCode, 200);
    const resolvedJob = resolveRes.json().job;
    assert.equal(resolvedJob.status, "COMPLETED");
    assert.equal(resolvedJob.completedChunks, 2);
    assert.equal(resolvedJob.deliveredAmount, "200000000000");
    assert.equal(harness.orders.get(order.id)?.status, OrderStatus.COMPLETED);
  } finally {
    if (app) await app.close();
    await queues.close();
  }
});
