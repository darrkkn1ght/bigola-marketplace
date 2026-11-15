import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  CustomerCategory,
  DisbursementChunkStatus,
  DisbursementJobStatus,
  GameAccountHealth,
  GameAccountRole,
  InventoryReservationStatus,
  OrderChannel,
  OrderStatus,
  OrderType,
  Prisma,
  RefundFinancialStatus,
  UserRole,
} from "@prisma/client";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import type { AuditLogRecord, AuditLogStore } from "./lib/audit.js";
import { hashSessionToken } from "./lib/crypto.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import type {
  AuthStore,
  AuthUserRecord,
  PlatformStore,
  SessionRecord,
} from "./lib/repositories.js";
import {
  ACCOUNT_COOLDOWN_MS,
  DisbursementService,
} from "./services/disbursement.js";
import { InventoryService } from "./services/inventory.js";
import {
  encodeEncryptedSessionBundle,
  LagosLifeAdapter,
} from "./services/lagoslife.js";

const TEST_ENCRYPTION_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function dec(val: bigint | number | string | Prisma.Decimal): Prisma.Decimal {
  if (val instanceof Prisma.Decimal) return val;
  return new Prisma.Decimal(val.toString());
}

function createStage9Harness(opts?: { disbursementEnabled?: boolean }) {
  const env = loadEnv({
    NODE_ENV: "test",
    OWNER_REQUIRE_2FA: "true",
    DISBURSEMENT_ENABLED: opts?.disbursementEnabled ? "true" : "false",
    ENCRYPTION_KEY_HEX: TEST_ENCRYPTION_KEY_HEX,
  });

  const ownerId = crypto.randomUUID();
  const partnerUserId = crypto.randomUUID();
  const customerUserId = crypto.randomUUID();
  const customerId = crypto.randomUUID();

  const users = new Map<string, AuthUserRecord>();
  const sessions = new Map<string, SessionRecord>();
  const auditLogs: AuditLogRecord[] = [];

  users.set(ownerId, {
    id: ownerId,
    email: "owner9@bigola.local",
    phone: null,
    passwordHash: "unused",
    role: UserRole.OWNER,
    isActive: true,
    mfaEnabled: true,
    encryptedTotpSecret: null,
    recoveryCodeHashes: null,
  });

  users.set(partnerUserId, {
    id: partnerUserId,
    email: "partner9@bigola.local",
    phone: null,
    passwordHash: "unused",
    role: UserRole.PARTNER,
    isActive: true,
    mfaEnabled: false,
    encryptedTotpSecret: null,
    recoveryCodeHashes: null,
  });

  users.set(customerUserId, {
    id: customerUserId,
    email: "customer9@bigola.local",
    phone: null,
    passwordHash: "unused",
    role: UserRole.CUSTOMER,
    isActive: true,
    mfaEnabled: false,
    encryptedTotpSecret: null,
    recoveryCodeHashes: null,
  });

  const ownerToken = "stage9-owner-token";
  const partnerToken = "stage9-partner-token";
  const customerToken = "stage9-customer-token";

  for (const [tok, uid, mfa] of [
    [ownerToken, ownerId, true],
    [partnerToken, partnerUserId, false],
    [customerToken, customerUserId, false],
  ] as const) {
    const th = hashSessionToken(tok, env.SESSION_SECRET);
    sessions.set(th, {
      id: crypto.randomUUID(),
      userId: uid,
      tokenHash: th,
      mfaVerified: mfa,
      ipAddress: "127.0.0.1",
      userAgent: "stage9-test",
      expiresAt: new Date(Date.now() + 3600_000),
      revokedAt: null,
    });
  }

  const authStore: AuthStore = {
    async findUserByEmail(email) {
      for (const u of users.values()) {
        if (u.email === email.toLowerCase()) return u;
      }
      return null;
    },
    async findUserById(id) {
      return users.get(id) ?? null;
    },
    async createUser() {
      throw new Error("Unused");
    },
    async updateUserMfa() {},
    async createSession() {
      throw new Error("Unused");
    },
    async findSessionByTokenHash(tokenHash) {
      const s = sessions.get(tokenHash);
      if (!s) return null;
      const u = users.get(s.userId);
      if (!u) return null;
      return { ...s, user: u };
    },
    async markSessionMfaVerified() {},
    async revokeSession() {},
  };

  const auditStore: AuditLogStore = {
    async create(entry) {
      const rec: AuditLogRecord = {
        id: crypto.randomUUID(),
        actorUserId: entry.actorUserId ?? null,
        actionType: entry.actionType,
        targetEntity: entry.targetEntity,
        targetId: entry.targetId ?? null,
        beforeState: entry.beforeState ?? null,
        afterState: entry.afterState ?? null,
        reason: entry.reason ?? null,
        ipAddress: entry.ipAddress ?? null,
        createdAt: new Date(),
      };
      auditLogs.push(rec);
      return rec;
    },
    async listRecent(limit = 50) {
      return auditLogs.slice(-limit).reverse();
    },
  };

  const platformStore: PlatformStore = {
    async getGameAccounts() {
      return [];
    },
    async getSettings() {
      return [];
    },
    async upsertSetting(key, value) {
      return { key, value, description: null, updatedAt: new Date() };
    },
    async findPartnerByUserId() {
      return null;
    },
    async listPartnerCustomers() {
      return [];
    },
  };

  const gameAccounts = new Map<string, any>();
  const orders = new Map<string, any>();
  const reservations = new Map<string, any>();
  const inventoryLedger: any[] = [];
  const disbursementJobs = new Map<string, any>();
  const disbursementChunks = new Map<string, any>();
  const notifications: any[] = [];

  const liveBalances = new Map<string, bigint>();
  const expiredCookies = new Set<string>();

  const slotDefs = [
    { slotCode: "MAIN_TREASURY", role: GameAccountRole.MAIN_TREASURY, username: "bigola2823", bal: 5_000_000_000_000n },
    { slotCode: "RESERVE_1", role: GameAccountRole.RESERVE, username: "bigola_res1", bal: 5_000_000_000_000n },
    { slotCode: "RESERVE_2", role: GameAccountRole.RESERVE, username: "bigola_res2", bal: 5_000_000_000_000n },
    { slotCode: "RESERVE_3", role: GameAccountRole.RESERVE, username: "bigola_res3", bal: 5_000_000_000_000n },
    { slotCode: "RESERVE_4", role: GameAccountRole.RESERVE, username: "bigola_res4", bal: 5_000_000_000_000n },
  ];

  for (const s of slotDefs) {
    const id = crypto.randomUUID();
    liveBalances.set(s.username, s.bal);
    const cookieVal = `ll_session=secret_${s.slotCode.toLowerCase()}`;
    gameAccounts.set(id, {
      id,
      slotCode: s.slotCode,
      accountRole: s.role,
      lagoslifeUsername: s.username,
      encryptedSessionBundle: encodeEncryptedSessionBundle(
        {
          cookie: cookieVal,
          uid: `uid_${s.slotCode}`,
          username: s.username,
          simName: s.slotCode,
          connectedAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
        },
        TEST_ENCRYPTION_KEY_HEX
      ),
      lastKnownBalance: dec(s.bal),
      logicalAllocationAmount: dec(s.bal),
      reservedForOrders: dec(0n),
      targetReserveAmount: dec(70_000_000_000_000n),
      healthStatus: GameAccountHealth.ACTIVE,
      lastSyncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  let virtualClockMs = 1_700_000_000_000;
  let activeSendCount = 0;
  let maxConcurrentSends = 0;
  const activeSendsPerCookie = new Map<string, number>();
  let concurrentSameAccountViolations = 0;
  const sendLog: Array<{ slotCode: string; amount: string }> = [];

  const mockFetch: typeof globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(urlStr);
    const cookie = new Headers(init?.headers).get("cookie") ?? "";

    const matchedSlot = slotDefs.find((s) =>
      cookie.includes(`secret_${s.slotCode.toLowerCase()}`)
    );

    if (matchedSlot && expiredCookies.has(matchedSlot.slotCode)) {
      return new Response(JSON.stringify({ error: "Session expired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    if (u.pathname === "/api/save") {
      if (!matchedSlot) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
      const bal = liveBalances.get(matchedSlot.username) ?? 0n;
      return new Response(
        JSON.stringify({ game: { money: Number(bal), sim: { name: matchedSlot.username } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (u.pathname === "/api/players") {
      return new Response(
        JSON.stringify({
          players: [{ id: "bc745837935d45efbf47", username: "milespete", name: "Miles Pete" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (u.pathname === "/api/send" && init?.method === "POST") {
      if (!matchedSlot) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
      const prevPerCookie = activeSendsPerCookie.get(matchedSlot.slotCode) ?? 0;
      if (prevPerCookie > 0) concurrentSameAccountViolations++;
      activeSendsPerCookie.set(matchedSlot.slotCode, prevPerCookie + 1);

      activeSendCount++;
      if (activeSendCount > maxConcurrentSends) maxConcurrentSends = activeSendCount;

      // Brief async yield to expose any true concurrency overlap
      await new Promise((r) => setTimeout(r, 25));

      const body = JSON.parse(String(init.body ?? "{}"));
      const amt = BigInt(String(body.amount));
      const cur = liveBalances.get(matchedSlot.username) ?? 0n;
      liveBalances.set(matchedSlot.username, cur - amt);
      sendLog.push({ slotCode: matchedSlot.slotCode, amount: amt.toString() });

      activeSendCount--;
      activeSendsPerCookie.set(matchedSlot.slotCode, prevPerCookie);

      return new Response(
        JSON.stringify({ ok: true, money: Number(cur - amt) }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  };

  const fakePrisma: any = {
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(fakePrisma),
    gameAccount: {
      findMany: async () =>
        [...gameAccounts.values()].sort((a, b) => a.slotCode.localeCompare(b.slotCode)),
      findUnique: async ({ where }: any) => {
        if (where.id) return gameAccounts.get(where.id) ?? null;
        if (where.slotCode) {
          return [...gameAccounts.values()].find((a) => a.slotCode === where.slotCode) ?? null;
        }
        return null;
      },
      update: async ({ where, data }: any) => {
        const acc = where.id
          ? gameAccounts.get(where.id)
          : [...gameAccounts.values()].find((a) => a.slotCode === where.slotCode);
        if (!acc) throw new Error("GameAccount not found");
        if (data.healthStatus !== undefined) acc.healthStatus = data.healthStatus;
        if (data.lastKnownBalance !== undefined) acc.lastKnownBalance = dec(data.lastKnownBalance);
        if (data.lastSyncedAt !== undefined) acc.lastSyncedAt = data.lastSyncedAt;
        if (data.reservedForOrders !== undefined) {
          if (typeof data.reservedForOrders === "object" && data.reservedForOrders.decrement) {
            const cur = BigInt(acc.reservedForOrders.toFixed(0));
            const sub = BigInt(data.reservedForOrders.decrement);
            acc.reservedForOrders = dec(cur > sub ? cur - sub : 0n);
          } else {
            acc.reservedForOrders = dec(data.reservedForOrders);
          }
        }
        acc.updatedAt = new Date();
        return acc;
      },
    },
    order: {
      findUnique: async ({ where }: any) => {
        const o = orders.get(where.id);
        if (!o) return null;
        return {
          ...o,
          reservations: [...reservations.values()].filter((r) => r.orderId === o.id),
          disbursementJobs: [...disbursementJobs.values()]
            .filter((j) => j.orderId === o.id)
            .map((j) => ({
              ...j,
              chunks: [...disbursementChunks.values()].filter((c) => c.jobId === j.id),
            })),
        };
      },
      update: async ({ where, data }: any) => {
        const o = orders.get(where.id);
        if (!o) throw new Error("Order not found");
        if (data.status !== undefined) o.status = data.status;
        if (data.gameAmountDelivered !== undefined) o.gameAmountDelivered = dec(data.gameAmountDelivered);
        if (data.fulfilledAmount !== undefined) o.fulfilledAmount = dec(data.fulfilledAmount);
        o.updatedAt = new Date();
        return o;
      },
    },
    inventoryReservation: {
      findMany: async ({ where }: any) =>
        [...reservations.values()].filter((r) => {
          if (where?.orderId && r.orderId !== where.orderId) return false;
          if (where?.status && r.status !== where.status) return false;
          return true;
        }),
      update: async ({ where, data }: any) => {
        const r = reservations.get(where.id);
        if (!r) throw new Error("Reservation not found");
        if (data.amount !== undefined) r.amount = dec(data.amount);
        if (data.status !== undefined) r.status = data.status;
        if (data.releasedAt !== undefined) r.releasedAt = data.releasedAt;
        return r;
      },
    },
    inventoryLedger: {
      create: async ({ data }: any) => {
        const e = { id: crypto.randomUUID(), ...data, createdAt: new Date() };
        inventoryLedger.push(e);
        return e;
      },
    },
    disbursementJob: {
      create: async ({ data }: any) => {
        const job = {
          id: crypto.randomUUID(),
          orderId: data.orderId,
          status: data.status,
          totalAmount: dec(data.totalAmount),
          deliveredAmount: dec(data.deliveredAmount ?? 0),
          totalChunks: data.totalChunks,
          completedChunks: data.completedChunks ?? 0,
          startedAt: null,
          completedAt: null,
          createdAt: new Date(),
        };
        disbursementJobs.set(job.id, job);
        return job;
      },
      findUnique: async ({ where, include }: any) => {
        const job = disbursementJobs.get(where.id);
        if (!job) return null;
        const copy: any = { ...job };
        if (include?.chunks) {
          copy.chunks = [...disbursementChunks.values()]
            .filter((c) => c.jobId === job.id)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        }
        return copy;
      },
      findMany: async ({ where, include }: any = {}) => {
        let list = [...disbursementJobs.values()];
        if (where?.orderId) list = list.filter((j) => j.orderId === where.orderId);
        if (where?.status) list = list.filter((j) => j.status === where.status);
        return list.map((j) => {
          const copy: any = { ...j };
          if (include?.chunks) {
            copy.chunks = [...disbursementChunks.values()]
              .filter((c) => c.jobId === j.id)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          }
          if (include?.order) {
            copy.order = orders.get(j.orderId) ?? null;
          }
          return copy;
        });
      },
      update: async ({ where, data }: any) => {
        const job = disbursementJobs.get(where.id);
        if (!job) throw new Error("Job not found");
        if (data.status !== undefined) job.status = data.status;
        if (data.deliveredAmount !== undefined) job.deliveredAmount = dec(data.deliveredAmount);
        if (data.completedChunks !== undefined) job.completedChunks = data.completedChunks;
        if (data.startedAt !== undefined) job.startedAt = data.startedAt;
        if (data.completedAt !== undefined) job.completedAt = data.completedAt;
        return job;
      },
    },
    disbursementChunk: {
      create: async ({ data }: any) => {
        const seq = disbursementChunks.size + 1;
        const chunk = {
          id: crypto.randomUUID(),
          jobId: data.jobId,
          sourceAccountId: data.sourceAccountId,
          recipientUsername: data.recipientUsername,
          amount: dec(data.amount),
          idempotencyKey: data.idempotencyKey,
          status: data.status,
          attemptCount: data.attemptCount ?? 0,
          httpStatus: null,
          errorMessage: null,
          reconciliationNote: null,
          executedAt: null,
          createdAt: new Date(Date.now() + seq),
        };
        disbursementChunks.set(chunk.id, chunk);
        return chunk;
      },
      findUnique: async ({ where }: any) => disbursementChunks.get(where.id) ?? null,
      findMany: async ({ where }: any) =>
        [...disbursementChunks.values()]
          .filter((c) => (where?.jobId ? c.jobId === where.jobId : true))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      update: async ({ where, data }: any) => {
        const c = disbursementChunks.get(where.id);
        if (!c) throw new Error("Chunk not found");
        if (data.status !== undefined) c.status = data.status;
        if (data.attemptCount !== undefined) {
          c.attemptCount =
            typeof data.attemptCount === "object" && data.attemptCount.increment
              ? c.attemptCount + data.attemptCount.increment
              : data.attemptCount;
        }
        if (data.httpStatus !== undefined) c.httpStatus = data.httpStatus;
        if (data.errorMessage !== undefined) c.errorMessage = data.errorMessage;
        if (data.reconciliationNote !== undefined) c.reconciliationNote = data.reconciliationNote;
        if (data.executedAt !== undefined) c.executedAt = data.executedAt;
        if (data.idempotencyKey !== undefined) c.idempotencyKey = data.idempotencyKey;
        return c;
      },
    },
    auditLog: {
      create: async ({ data }: any) =>
        auditStore.create({
          actorUserId: data.actorUserId,
          actionType: data.actionType,
          targetEntity: data.targetEntity,
          targetId: data.targetId,
          beforeState: data.beforeState,
          afterState: data.afterState,
          reason: data.reason,
          ipAddress: data.ipAddress,
        }),
    },
    customer: {
      findUnique: async () => ({ userId: customerUserId }),
    },
    partner: {
      findUnique: async () => null,
    },
    notification: {
      create: async ({ data }: any) => {
        notifications.push(data);
        return data;
      },
      createMany: async ({ data }: any) => {
        notifications.push(...data);
        return { count: data.length };
      },
    },
  };

  const adapter = new LagosLifeAdapter({ fetchImpl: mockFetch });
  const inventoryService = new InventoryService(fakePrisma, {
    encryptionKeyHex: TEST_ENCRYPTION_KEY_HEX,
    lagosLifeAdapter: adapter,
  });
  const disbursementService = new DisbursementService(
    fakePrisma,
    TEST_ENCRYPTION_KEY_HEX,
    adapter,
    {
      redis: null,
      disbursementEnabled: opts?.disbursementEnabled ?? false,
      nowFn: () => virtualClockMs,
      sleepFn: async (ms: number) => {
        virtualClockMs += ms + 50;
      },
    }
  );

  function createReadyOrder(allocs: Array<{ slotCode: string; amount: bigint }>) {
    const orderId = crypto.randomUUID();
    const total = allocs.reduce((s, a) => s + a.amount, 0n);
    const order = {
      id: orderId,
      orderNumber: `ORD-9-${orderId.slice(0, 6).toUpperCase()}`,
      paymentReference: `BGL-9-${orderId.slice(0, 6).toUpperCase()}`,
      channel: OrderChannel.ONLINE,
      orderType: OrderType.BULK,
      customerId,
      customerCategory: CustomerCategory.CATEGORY_B_BIGOLA,
      partnerId: null,
      recipientLagoslifeUsername: "milespete",
      gameAmountRequested: dec(total),
      gameAmountDelivered: dec(0n),
      fulfilledAmount: dec(0n),
      fiatAmountKobo: 1_000_000n,
      verifiedGrossFiatKobo: 1_000_000n,
      confirmedRefundedKobo: 0n,
      refundFinancialStatus: RefundFinancialStatus.NONE,
      status: OrderStatus.READY_FOR_FULFILMENT,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    orders.set(orderId, order);

    for (const alloc of allocs) {
      const acc = [...gameAccounts.values()].find((a) => a.slotCode === alloc.slotCode);
      assert.ok(acc);
      const resId = crypto.randomUUID();
      reservations.set(resId, {
        id: resId,
        orderId,
        gameAccountId: acc.id,
        amount: dec(alloc.amount),
        status: InventoryReservationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 3600_000),
        releasedAt: null,
      });
      acc.reservedForOrders = dec(BigInt(acc.reservedForOrders.toFixed(0)) + alloc.amount);
    }

    return order;
  }

  return {
    env,
    ownerId,
    ownerToken,
    partnerToken,
    customerToken,
    authStore,
    auditStore,
    auditLogs,
    platformStore,
    prisma: fakePrisma,
    gameAccounts,
    disbursementJobs,
    disbursementChunks,
    inventoryService,
    disbursementService,
    createReadyOrder,
    advanceClockMs(ms: number) {
      virtualClockMs += ms;
    },
    expireSession(slotCode: string) {
      expiredCookies.add(slotCode);
    },
    getMetrics() {
      return {
        maxConcurrentSends,
        concurrentSameAccountViolations,
        sendLog,
      };
    },
  };
}

test("Stage 9: Multi-Pipeline Concurrency, Worker Crash Recovery, Failure Isolation & Operations Dashboard", async () => {
  const harness = createStage9Harness({ disbursementEnabled: true });
  let queues: ReturnType<typeof createQueueInfrastructure> | null = null;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  try {
    queues = createQueueInfrastructure(undefined);
    app = await buildApp({
      env: harness.env,
      authStore: harness.authStore,
      auditStore: harness.auditStore,
      platformStore: harness.platformStore,
      queues,
      prisma: harness.prisma,
      inventoryService: harness.inventoryService,
      disbursementService: harness.disbursementService,
      checkDb: async () => true,
    });

    // 1. Multi-Order, Multi-Account Concurrent Pipelines:
    // Order A uses MAIN_TREASURY (150B -> 2 chunks: 100B + 50B) + RESERVE_1 (100B)
    // Order B uses RESERVE_2 (100B) + RESERVE_3 (100B)
    // Order C uses RESERVE_4 (100B)
    const orderA = harness.createReadyOrder([
      { slotCode: "MAIN_TREASURY", amount: 150_000_000_000n },
      { slotCode: "RESERVE_1", amount: 100_000_000_000n },
    ]);
    const orderB = harness.createReadyOrder([
      { slotCode: "RESERVE_2", amount: 100_000_000_000n },
      { slotCode: "RESERVE_3", amount: 100_000_000_000n },
    ]);
    const orderC = harness.createReadyOrder([
      { slotCode: "RESERVE_4", amount: 100_000_000_000n },
    ]);

    const jobA = await harness.disbursementService.authorizeDisbursementJob({
      orderId: orderA.id,
      actorUserId: harness.ownerId,
      actorRole: UserRole.OWNER,
      allocations: [
        { slotCode: "MAIN_TREASURY", amount: 150_000_000_000n },
        { slotCode: "RESERVE_1", amount: 100_000_000_000n },
      ],
    });
    const jobB = await harness.disbursementService.authorizeDisbursementJob({
      orderId: orderB.id,
      actorUserId: harness.ownerId,
      actorRole: UserRole.OWNER,
      allocations: [
        { slotCode: "RESERVE_2", amount: 100_000_000_000n },
        { slotCode: "RESERVE_3", amount: 100_000_000_000n },
      ],
    });
    const jobC = await harness.disbursementService.authorizeDisbursementJob({
      orderId: orderC.id,
      actorUserId: harness.ownerId,
      actorRole: UserRole.OWNER,
      allocations: [{ slotCode: "RESERVE_4", amount: 100_000_000_000n }],
    });

    await Promise.all([
      harness.disbursementService.prepareJobForQueuedExecution({
        jobId: jobA.id,
        actorUserId: harness.ownerId,
        actorRole: UserRole.OWNER,
      }),
      harness.disbursementService.prepareJobForQueuedExecution({
        jobId: jobB.id,
        actorUserId: harness.ownerId,
        actorRole: UserRole.OWNER,
      }),
      harness.disbursementService.prepareJobForQueuedExecution({
        jobId: jobC.id,
        actorUserId: harness.ownerId,
        actorRole: UserRole.OWNER,
      }),
    ]);

    // Execute all 3 independent jobs concurrently in worker-step mode!
    const [stepA1, stepB1, stepC1] = await Promise.all([
      harness.disbursementService.processJobStepForWorker({
        jobId: jobA.id,
        actorUserId: harness.ownerId,
      }),
      harness.disbursementService.processJobStepForWorker({
        jobId: jobB.id,
        actorUserId: harness.ownerId,
      }),
      harness.disbursementService.processJobStepForWorker({
        jobId: jobC.id,
        actorUserId: harness.ownerId,
      }),
    ]);

    // Distinct accounts executed concurrently (maxConcurrentSends >= 2), with ZERO same-account overlap
    const metrics1 = harness.getMetrics();
    assert.ok(metrics1.maxConcurrentSends >= 2, `Expected concurrent multi-account sends, got ${metrics1.maxConcurrentSends}`);
    assert.equal(metrics1.concurrentSameAccountViolations, 0);

    // Job B (2 chunks across RESERVE_2 & RESERVE_3) and Job C (1 chunk on RESERVE_4) completed in 1 pass
    assert.equal(stepB1.job?.status, DisbursementJobStatus.COMPLETED);
    assert.equal(stepB1.nextDelayMs, null);
    assert.equal(stepC1.job?.status, DisbursementJobStatus.COMPLETED);
    assert.equal(stepC1.nextDelayMs, null);

    // Job A completed 2 of 3 chunks (MAIN_TREASURY 100B + RESERVE_1 100B), and returned nextDelayMs (~30.5s) for MAIN_TREASURY's 50B chunk
    assert.equal(stepA1.job?.status, DisbursementJobStatus.RUNNING);
    assert.equal(stepA1.job?.completedChunks, 2);
    assert.ok(stepA1.nextDelayMs !== null && stepA1.nextDelayMs >= 30_000);

    // 2. Same-Account Concurrency Prevention across two competing jobs on MAIN_TREASURY
    const orderD = harness.createReadyOrder([{ slotCode: "MAIN_TREASURY", amount: 50_000_000_000n }]);
    const jobD = await harness.disbursementService.authorizeDisbursementJob({
      orderId: orderD.id,
      actorUserId: harness.ownerId,
      actorRole: UserRole.OWNER,
      allocations: [{ slotCode: "MAIN_TREASURY", amount: 50_000_000_000n }],
    });
    await harness.disbursementService.prepareJobForQueuedExecution({
      jobId: jobD.id,
      actorUserId: harness.ownerId,
      actorRole: UserRole.OWNER,
    });

    // Advance virtual clock past 30.5s cooldown, then race Job A (chunk 3: 50B on MAIN_TREASURY) and Job D (50B on MAIN_TREASURY)
    harness.advanceClockMs(ACCOUNT_COOLDOWN_MS + 1000);
    await Promise.all([
      harness.disbursementService.processJobStepForWorker({ jobId: jobA.id, actorUserId: harness.ownerId }),
      harness.disbursementService.processJobStepForWorker({ jobId: jobD.id, actorUserId: harness.ownerId }),
    ]);

    assert.equal(harness.getMetrics().concurrentSameAccountViolations, 0);
    const jobAFinal = await harness.disbursementService.getJobDetail(jobA.id);
    assert.equal(jobAFinal.status, DisbursementJobStatus.COMPLETED);

    // Advance cooldown again if Job D was deferred by cooldown/lock and finish Job D
    harness.advanceClockMs(ACCOUNT_COOLDOWN_MS + 1000);
    const stepD2 = await harness.disbursementService.processJobStepForWorker({
      jobId: jobD.id,
      actorUserId: harness.ownerId,
    });
    assert.equal(stepD2.job?.status, DisbursementJobStatus.COMPLETED);

    // 3. Worker Crash Recovery: Stale IN_FLIGHT chunk must become AMBIGUOUS_MANUAL_REVIEW & PAUSED (never blindly retried)
    const orderCrash = harness.createReadyOrder([{ slotCode: "RESERVE_2", amount: 50_000_000_000n }]);
    const jobCrash = await harness.disbursementService.authorizeDisbursementJob({
      orderId: orderCrash.id,
      actorUserId: harness.ownerId,
      actorRole: UserRole.OWNER,
      allocations: [{ slotCode: "RESERVE_2", amount: 50_000_000_000n }],
    });
    await harness.disbursementService.prepareJobForQueuedExecution({
      jobId: jobCrash.id,
      actorUserId: harness.ownerId,
      actorRole: UserRole.OWNER,
    });
    // Simulate a hard worker crash right after setting chunk to IN_FLIGHT
    const crashChunkId = jobCrash.chunks[0]!.id;
    await harness.prisma.disbursementChunk.update({
      where: { id: crashChunkId },
      data: { status: DisbursementChunkStatus.IN_FLIGHT, attemptCount: 1 },
    });

    // Also create a healthy RUNNING job that should survive restart and be returned for re-enqueue
    const orderResume = harness.createReadyOrder([{ slotCode: "RESERVE_3", amount: 50_000_000_000n }]);
    const jobResume = await harness.disbursementService.authorizeDisbursementJob({
      orderId: orderResume.id,
      actorUserId: harness.ownerId,
      actorRole: UserRole.OWNER,
      allocations: [{ slotCode: "RESERVE_3", amount: 50_000_000_000n }],
    });
    await harness.disbursementService.prepareJobForQueuedExecution({
      jobId: jobResume.id,
      actorUserId: harness.ownerId,
      actorRole: UserRole.OWNER,
    });

    const recovery = await harness.disbursementService.recoverStaleInFlightChunksAndJobs();
    assert.ok(recovery.pausedAmbiguousJobIds.includes(jobCrash.id));
    assert.ok(recovery.resumableRunningJobIds.includes(jobResume.id));

    const recoveredCrashJob = await harness.disbursementService.getJobDetail(jobCrash.id);
    assert.equal(recoveredCrashJob.status, DisbursementJobStatus.PAUSED);
    assert.equal(recoveredCrashJob.chunks[0]!.status, DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW);
    assert.ok(
      harness.auditLogs.some((a) => a.actionType === "DISBURSEMENT_CHUNK_CRASH_RECOVERY_PAUSED")
    );

    // 4. Failure Isolation: Expired session on RESERVE_1 pauses only RESERVE_1's job, not RESERVE_3's job
    harness.expireSession("RESERVE_1");
    const orderExp = harness.createReadyOrder([{ slotCode: "RESERVE_1", amount: 50_000_000_000n }]);
    const jobExp = await harness.disbursementService.authorizeDisbursementJob({
      orderId: orderExp.id,
      actorUserId: harness.ownerId,
      actorRole: UserRole.OWNER,
      allocations: [{ slotCode: "RESERVE_1", amount: 50_000_000_000n }],
    });
    await harness.disbursementService.prepareJobForQueuedExecution({
      jobId: jobExp.id,
      actorUserId: harness.ownerId,
      actorRole: UserRole.OWNER,
    });

    harness.advanceClockMs(ACCOUNT_COOLDOWN_MS + 1000);
    await Promise.all([
      harness.disbursementService.processJobStepForWorker({ jobId: jobExp.id, actorUserId: harness.ownerId }),
      harness.disbursementService.processJobStepForWorker({ jobId: jobResume.id, actorUserId: harness.ownerId }),
    ]);

    const expJobAfter = await harness.disbursementService.getJobDetail(jobExp.id);
    const resumeJobAfter = await harness.disbursementService.getJobDetail(jobResume.id);
    assert.equal(expJobAfter.status, DisbursementJobStatus.PAUSED);
    assert.equal(resumeJobAfter.status, DisbursementJobStatus.COMPLETED);

    // 5. Owner Operational Pipeline Dashboard API & RBAC / Secret Hygiene
    const pipeRes = await app.inject({
      method: "GET",
      url: "/api/v1/owner/operations/pipelines",
      headers: { authorization: `Bearer ${harness.ownerToken}` },
    });
    assert.equal(pipeRes.statusCode, 200);
    const pipeBody = pipeRes.json();
    assert.equal(pipeBody.accounts.length, 5);
    assert.equal(pipeBody.summary.expiredSessionAccountsCount, 1);
    assert.equal(pipeBody.summary.ambiguousChunksCount, 1);
    assert.ok(pipeBody.summary.completedJobs >= 4);
    assert.ok(!JSON.stringify(pipeBody).includes("secret_main_treasury"));
    assert.ok(!JSON.stringify(pipeBody).includes("secret_reserve_1"));

    // Partner and Customer are denied access to Owner operational dashboard
    const partnerPipe = await app.inject({
      method: "GET",
      url: "/api/v1/owner/operations/pipelines",
      headers: { authorization: `Bearer ${harness.partnerToken}` },
    });
    assert.equal(partnerPipe.statusCode, 403);

    const custPipe = await app.inject({
      method: "GET",
      url: "/api/v1/owner/operations/pipelines",
      headers: { authorization: `Bearer ${harness.customerToken}` },
    });
    assert.equal(custPipe.statusCode, 403);
  } finally {
    if (app) {
      await app.close().catch(() => undefined);
    }
    if (queues) {
      await queues.close().catch(() => undefined);
    }
  }
});
