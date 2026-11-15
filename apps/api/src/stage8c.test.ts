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
import { DisbursementService } from "./services/disbursement.js";
import { InventoryService } from "./services/inventory.js";
import { encodeEncryptedSessionBundle, LagosLifeAdapter } from "./services/lagoslife.js";
import { OperationsService } from "./services/operations.js";

const TEST_ENCRYPTION_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_SESSION_SECRET = "stage8c-test-session-secret-minimum-32-chars!!";

function dec(val: bigint | number | string): Prisma.Decimal {
  return new Prisma.Decimal(val.toString());
}

function createIsolatedStage8CHarness(options?: {
  fetchImpl?: typeof fetch;
  disbursementEnabled?: boolean;
  nowFn?: () => number;
}) {
  const ownerUserId = crypto.randomUUID();
  const customerUserId = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const ownerSessionId = crypto.randomUUID();
  const customerSessionId = crypto.randomUUID();

  const ownerToken = "stage8c_owner_raw_token";
  const customerToken = "stage8c_customer_raw_token";
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
      initialBalance: 500_000_000_000n, // 500B on RESERVE_4 to test inventory cap validation
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
        cookie: `ll_session=secret_cookie_${def.slotCode.toLowerCase()}`,
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
      gameAmountDelivered: Prisma.Decimal;
      fulfilledAmount: Prisma.Decimal;
      fiatAmountKobo: bigint;
      verifiedGrossFiatKobo: bigint;
      confirmedRefundedKobo: bigint;
      pricingSnapshot: Prisma.JsonValue;
      paymentExceptionType: string;
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

  function createOrderFixture(params: {
    recipientLagoslifeUsername: string;
    gameAmountRequested: bigint;
    status: OrderStatus;
    reserveOnSlot?: string;
  }) {
    const id = crypto.randomUUID();
    const order = {
      id,
      orderNumber: `ORD-8C-${orders.size + 1}`,
      paymentReference: `BGL-8C-${orders.size + 1}`,
      channel: OrderChannel.ONLINE,
      orderType: OrderType.BULK,
      customerId,
      customerCategory: CustomerCategory.DIRECT,
      partnerId: null,
      recipientLagoslifeUsername: params.recipientLagoslifeUsername,
      gameAmountRequested: dec(params.gameAmountRequested),
      gameAmountDelivered: dec(0n),
      fulfilledAmount: dec(0n),
      fiatAmountKobo: 50_000_000n,
      verifiedGrossFiatKobo: 50_000_000n,
      confirmedRefundedKobo: 0n,
      pricingSnapshot: { priceKoboPerTrillion: "100000000" },
      paymentExceptionType: "NONE",
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
    platformSetting: {
      findUnique: async () => null,
      findMany: async () => [],
    },
    inventoryDiscrepancy: {
      count: async () => 0,
      findMany: async () => [],
    },
    manualFulfilmentRecord: {
      findMany: async () => [],
    },
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
        if (data.gameAmountDelivered !== undefined) {
          o.gameAmountDelivered = dec(String(data.gameAmountDelivered));
        }
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
      findMany: async () =>
        inventoryLedgers.map((l) => ({
          ...l,
          gameAccount: gameAccounts.get(l.gameAccountId) ?? { slotCode: "MAIN_TREASURY" },
        })),
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
            fullName: "Stage 8C Test Customer",
            email: "customer8c@bigola.local",
            phone: "+2348000000089",
            lagoslifeUsername: "milespete",
            category: CustomerCategory.DIRECT,
            attributedPartnerId: null,
          };
        }
        return null;
      },
    },
    notification: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: crypto.randomUUID(),
        ...data,
      }),
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
    email: "customer8c@bigola.local",
    phone: "+2348000000089",
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
          userAgent: "stage8c-test",
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
          userAgent: "stage8c-test",
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
    upsertSetting: async (key, value, updatedBy) => ({
      key,
      value,
      updatedBy,
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
    QUEUE_PREFIX: "bigola-test-8c",
  };

  const adapter = new LagosLifeAdapter({
    fetchImpl: options?.fetchImpl,
  });

  const inventoryService = new InventoryService(mockPrisma as unknown as PrismaClient, {
    encryptionKeyHex: TEST_ENCRYPTION_KEY_HEX,
    lagosLifeAdapter: adapter,
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
        paymentExceptionType: o.paymentExceptionType,
        refundFinancialStatus: o.refundFinancialStatus,
        recipientLagoslifeUsername: o.recipientLagoslifeUsername,
        gameAmountRequested: o.gameAmountRequested.toFixed(0),
        gameAmountDelivered: o.gameAmountDelivered.toFixed(0),
        fulfilledAmount: o.fulfilledAmount.toFixed(0),
        fiatAmountKobo: o.fiatAmountKobo.toString(),
        verifiedGrossFiatKobo: o.verifiedGrossFiatKobo.toString(),
        confirmedRefundedKobo: o.confirmedRefundedKobo.toString(),
        createdAt: o.createdAt.toISOString(),
        customer: {
          id: customerId,
          fullName: "Stage 8C Test Customer",
          email: "customer8c@bigola.local",
          phone: "+2348000000089",
          lagoslifeUsername: "milespete",
          category: "DIRECT",
        },
        partner: null,
        paymentProofs: [],
        verificationDecisions: [],
        reservations: Array.from(reservations.values())
          .filter((r) => r.orderId === o.id)
          .map((r) => ({
            id: r.id,
            gameAccountId: r.gameAccountId,
            slotCode: gameAccounts.get(r.gameAccountId)?.slotCode ?? "MAIN_TREASURY",
            amount: r.amount.toFixed(0),
            status: r.status,
            expiresAt: null,
          })),
        manualFulfilments: [],
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
    inventoryService,
    disbursementService,
    operationsService: mockOperationsService,
    ownerToken,
    customerToken,
    orders,
    createOrderFixture,
  };
}

test("Stage 8C: Complete Owner 5-Account Inventory, Order Disbursement Controls, and Customer Delivery Tracking Privacy", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/save")) {
      return new Response(
        JSON.stringify({
          game: {
            money: 100_000_000_000_000,
            sim: { name: "BigOlaSlot" },
            owner: "6e3c4bdaac6f4765ba52",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.endsWith("/api/send")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  };

  const harness = createIsolatedStage8CHarness({
    fetchImpl: mockFetch,
    disbursementEnabled: false,
  });
  const queues = createQueueInfrastructure("", "bigola-test-8c");
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  try {
    app = await buildApp({
      env: harness.env,
      authStore: harness.authStore,
      auditStore: harness.auditStore,
      platformStore: harness.platformStore,
      queues,
      prisma: harness.prisma,
      inventoryService: harness.inventoryService,
      disbursementService: harness.disbursementService,
      operationsService: harness.operationsService,
      checkDb: async () => true,
    });

    // 1. Verify /api/v1/owner/inventory returns all 5 accounts, all eligible for fulfilment, and zero secret leakage
    const invRes = await app.inject({
      method: "GET",
      url: "/api/v1/owner/inventory",
      headers: { authorization: `Bearer ${harness.ownerToken}` },
    });
    assert.equal(invRes.statusCode, 200);
    const invBody = invRes.json();
    assert.equal(invBody.slots.length, 5);
    const slotCodes = invBody.slots.map((s: { slotCode: string }) => s.slotCode);
    assert.deepEqual(slotCodes, [
      "MAIN_TREASURY",
      "RESERVE_1",
      "RESERVE_2",
      "RESERVE_3",
      "RESERVE_4",
    ]);
    for (const slot of invBody.slots) {
      assert.equal(slot.eligibleForFulfilment, true);
      assert.equal(slot.connectionStatus, "CONNECTED");
      assert.equal(slot.encryptedSessionBundle, undefined);
    }
    assert.ok(!JSON.stringify(invBody).includes("secret_cookie_"));

    // 2. Verify recipient resolution endpoint used by Owner Order Detail panel
    const resolveRes = await app.inject({
      method: "GET",
      url: "/api/v1/owner/inventory/resolve-player?username=milespete",
      headers: { authorization: `Bearer ${harness.ownerToken}` },
    });
    assert.equal(resolveRes.statusCode, 200);
    assert.equal(resolveRes.json().resolved, true);
    assert.equal(resolveRes.json().player.id, "bc745837935d45efbf47");

    // 3. Verify allocation exceeding available account balance is rejected (RESERVE_4 has 500B, try allocating 600B)
    const order = harness.createOrderFixture({
      recipientLagoslifeUsername: "milespete",
      gameAmountRequested: 600_000_000_000n, // 600B
      status: OrderStatus.READY_FOR_FULFILMENT,
      reserveOnSlot: "MAIN_TREASURY",
    });

    const overBalanceRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${order.id}/disbursements/authorize`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {
        allocations: [{ slotCode: "RESERVE_4", amount: "600000000000" }],
      },
    });
    assert.equal(overBalanceRes.statusCode, 409);
    assert.equal(overBalanceRes.json().code, "INSUFFICIENT_SOURCE_ACCOUNT_BALANCE");

    // 4. Authorize valid multi-account split (MAIN_TREASURY 100B + RESERVE_1 100B = 200B partial job), test Pause, Resume, Execute, and Cancel
    const authRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${order.id}/disbursements/authorize`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {
        allocations: [
          { slotCode: "MAIN_TREASURY", amount: "100000000000" },
          { slotCode: "RESERVE_1", amount: "100000000000" },
        ],
        authorizationNote: "Private Owner split note - never expose to customer",
      },
    });
    assert.equal(authRes.statusCode, 201);
    const job = authRes.json().job;
    assert.equal(job.totalChunks, 2);

    // Pause job
    const pauseRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${job.id}/pause`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { reason: "Owner review before execution" },
    });
    assert.equal(pauseRes.statusCode, 200);
    assert.equal(pauseRes.json().job.status, "PAUSED");

    // Resume job
    const resumeRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${job.id}/resume`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { reason: "Owner confirmed ready" },
    });
    assert.equal(resumeRes.statusCode, 200);
    assert.equal(resumeRes.json().job.status, "PENDING");

    // Enable disbursement in test harness to execute 1 chunk (100B), then cancel remaining 1 chunk
    harness.disbursementService.setDisbursementEnabledForTesting(true);
    const exec1Res = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${job.id}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { maxChunksToProcess: 1 },
    });
    assert.equal(exec1Res.statusCode, 200);
    assert.equal(exec1Res.json().job.completedChunks, 1);
    assert.equal(exec1Res.json().job.deliveredAmount, "100000000000");

    // Cancel remaining chunk -> Job becomes PARTIAL, Order is PARTIALLY_FULFILLED with 100B delivered
    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${job.id}/cancel`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { reason: "Cancel second chunk for customer test" },
    });
    assert.equal(cancelRes.statusCode, 200);
    assert.equal(cancelRes.json().job.status, "PARTIAL");

    // 5. Verify Customer Order Detail & Disbursement Tracking endpoints return exact delivery amounts and ZERO internal/owner data
    const custOrderRes = await app.inject({
      method: "GET",
      url: `/api/v1/customer/orders/${order.id}`,
      headers: { authorization: `Bearer ${harness.customerToken}` },
    });
    assert.equal(custOrderRes.statusCode, 200);
    const custOrder = custOrderRes.json().order;
    assert.equal(custOrder.status, "PARTIALLY_FULFILLED");
    assert.equal(custOrder.gameAmountRequested, "600000000000");
    assert.equal(custOrder.gameAmountDelivered, "100000000000");
    assert.equal(custOrder.fulfilledAmount, "100000000000");

    const custDisbRes = await app.inject({
      method: "GET",
      url: `/api/v1/customer/orders/${order.id}/disbursements`,
      headers: { authorization: `Bearer ${harness.customerToken}` },
    });
    assert.equal(custDisbRes.statusCode, 200);
    const custDisbText = JSON.stringify(custDisbRes.json());
    assert.equal(custDisbRes.json().jobs[0].deliveredAmount, "100000000000");
    assert.equal(custDisbRes.json().jobs[0].completedChunks, 1);
    assert.equal(custDisbRes.json().jobs[0].totalChunks, 2);

    // Privacy assertions: Customer payload never exposes internal accounts, slot codes, cookies, or Owner notes
    assert.ok(!custDisbText.includes("bigola2823"));
    assert.ok(!custDisbText.includes("bigola_res1"));
    assert.ok(!custDisbText.includes("MAIN_TREASURY"));
    assert.ok(!custDisbText.includes("RESERVE_1"));
    assert.ok(!custDisbText.includes("secret_cookie_"));
    assert.ok(!custDisbText.includes("Private Owner split note"));
  } finally {
    if (app) await app.close();
    await queues.close();
  }
});
