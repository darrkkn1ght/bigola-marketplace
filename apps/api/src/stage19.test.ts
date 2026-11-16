import assert from "node:assert/strict";
import test from "node:test";
import {
  DisbursementChunkStatus,
  DisbursementJobStatus,
  GameAccountHealth,
  GameAccountRole,
  InventoryReservationStatus,
  OrderStatus,
  UserRole,
} from "@prisma/client";
import {
  decodeEncryptedSessionBundle,
  encodeEncryptedSessionBundle,
  getSafeSessionMetadata,
  LagosLifeAdapter,
} from "./services/lagoslife.js";
import { InventoryService } from "./services/inventory.js";
import { DisbursementService } from "./services/disbursement.js";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("Stage 19.1: Per-account AES-256-GCM PIN encryption, rotation, clearing, and secret-free metadata", async () => {
  const bundleA = encodeEncryptedSessionBundle(
    {
      cookie: "ll_session=secret_cookie_a",
      uid: "u1",
      username: "bigola2823",
      simName: "teslim__",
      connectedAt: "2026-11-16T00:00:00.000Z",
      verifiedAt: "2026-11-16T00:00:00.000Z",
      transactionPin: "1122",
      pinUpdatedAt: "2026-11-16T00:00:00.000Z",
    },
    TEST_KEY
  );
  const bundleB = encodeEncryptedSessionBundle(
    {
      cookie: "ll_session=secret_cookie_b",
      uid: "u2",
      username: "mr_von_",
      simName: "Mr_Von_",
      connectedAt: "2026-11-16T00:00:00.000Z",
      verifiedAt: "2026-11-16T00:00:00.000Z",
      transactionPin: "9988",
      pinUpdatedAt: "2026-11-16T00:00:00.000Z",
    },
    TEST_KEY
  );

  assert.equal(bundleA.includes("1122"), false);
  assert.equal(bundleB.includes("9988"), false);
  assert.equal(decodeEncryptedSessionBundle(bundleA, TEST_KEY)?.transactionPin, "1122");
  assert.equal(decodeEncryptedSessionBundle(bundleB, TEST_KEY)?.transactionPin, "9988");

  const safeA = getSafeSessionMetadata(bundleA, TEST_KEY);
  assert.equal(safeA.hasPin, true);
  assert.equal(JSON.stringify(safeA).includes("1122"), false);
  assert.equal(JSON.stringify(safeA).includes("secret_cookie_a"), false);

  const accounts = new Map<string, Record<string, unknown>>([
    [
      "MAIN_TREASURY",
      {
        id: "acc-main",
        slotCode: "MAIN_TREASURY",
        lagoslifeUsername: "bigola2823",
        accountRole: GameAccountRole.MAIN_TREASURY,
        healthStatus: GameAccountHealth.ACTIVE,
        lastKnownBalance: "10000000000000",
        reservedForOrders: "0",
        targetReserveAmount: "0",
        logicalAllocationAmount: "0",
        lastSyncedAt: new Date(),
        encryptedSessionBundle: bundleA,
      },
    ],
  ]);
  const auditLogs: Array<Record<string, unknown>> = [];

  const mockPrisma = {
    gameAccount: {
      findUnique: async ({ where }: { where: { slotCode?: string; id?: string } }) => {
        if (where.slotCode) return accounts.get(where.slotCode) ?? null;
        return [...accounts.values()].find((a) => a.id === where.id) ?? null;
      },
      findMany: async () => [...accounts.values()],
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const acc = [...accounts.values()].find((a) => a.id === where.id)!;
        Object.assign(acc, data);
        return acc;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditLogs.push(data);
        return data;
      },
    },
  } as unknown as ConstructorParameters<typeof InventoryService>[0];

  const inv = new InventoryService(mockPrisma, { encryptionKeyHex: TEST_KEY });
  const rotated = await inv.setAccountTransactionPin({
    actorUserId: "owner-1",
    slotCode: "MAIN_TREASURY",
    pin: "4455",
    reason: "Rotate PIN",
  });
  assert.equal(rotated.hasPin, true);
  assert.equal(
    decodeEncryptedSessionBundle(accounts.get("MAIN_TREASURY")!.encryptedSessionBundle as string, TEST_KEY)
      ?.transactionPin,
    "4455"
  );
  assert.equal(JSON.stringify(auditLogs).includes("4455"), false);

  const cleared = await inv.clearAccountTransactionPin({
    actorUserId: "owner-1",
    slotCode: "MAIN_TREASURY",
    reason: "Clear PIN",
  });
  assert.equal(cleared.hasPin, false);
  assert.equal(
    decodeEncryptedSessionBundle(accounts.get("MAIN_TREASURY")!.encryptedSessionBundle as string, TEST_KEY)
      ?.transactionPin,
    null
  );
});

test("Stage 19.2: Missing/Incorrect PIN, Optional 2FA challenge/resume, and Ambiguous Recovery with mocked LagosLife", async () => {
  const sentPayloads: Array<{ body: Record<string, unknown>; idempotencyKey: string | null }> = [];
  let mode: "MISSING_PIN" | "WRONG_PIN" | "NEED_2FA" | "SUCCEED" | "UNCERTAIN_ZERO" = "MISSING_PIN";
  let liveBalance = "500000000000";

  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/save")) {
      return new Response(
        JSON.stringify({ game: { money: liveBalance, sim: { name: "teslim__" }, owner: "u1" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.endsWith("/api/send")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      sentPayloads.push({ body, idempotencyKey: hdrs["idempotency-key"] ?? null });

      if (mode === "MISSING_PIN" || mode === "WRONG_PIN") {
        return new Response(JSON.stringify({ error: "Invalid transaction PIN" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (mode === "NEED_2FA") {
        return new Response(JSON.stringify({ error: "Two-step 2FA verification code required" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      if (mode === "UNCERTAIN_ZERO") {
        return new Response(JSON.stringify({ error: "Upstream 502" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      if (body.pin !== "7788" || body.code !== "654321" || body.twoStep !== "654321") {
        return new Response(JSON.stringify({ error: "Missing pin or twoStep code" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  };

  const adapter = new LagosLifeAdapter({ fetchImpl: mockFetch });
  let nowMs = 1_700_000_000_000;

  const account = {
    id: "acc-1",
    slotCode: "MAIN_TREASURY",
    lagoslifeUsername: "bigola2823",
    healthStatus: GameAccountHealth.ACTIVE,
    lastKnownBalance: "500000000000",
    reservedForOrders: "100000000000",
    encryptedSessionBundle: encodeEncryptedSessionBundle(
      {
        cookie: "ll_session=mock_cookie",
        uid: "u1",
        username: "bigola2823",
        simName: "teslim__",
        connectedAt: "2026-11-16T00:00:00.000Z",
        verifiedAt: "2026-11-16T00:00:00.000Z",
        transactionPin: null,
        pinUpdatedAt: null,
      },
      TEST_KEY
    ),
  };

  const order = {
    id: "ord-1",
    orderNumber: "ORD-TEST-1",
    recipientLagoslifeUsername: "suzillious",
    status: OrderStatus.DISBURSING,
    gameAmountRequested: "100000000000",
    gameAmountDelivered: "0",
    fulfilledAmount: "0",
    reservations: [
      {
        id: "res-1",
        orderId: "ord-1",
        gameAccountId: "acc-1",
        amount: "100000000000",
        status: InventoryReservationStatus.ACTIVE,
      },
    ],
  };

  const job = {
    id: "job-1",
    orderId: "ord-1",
    totalAmount: "100000000000",
    deliveredAmount: "0",
    status: DisbursementJobStatus.RUNNING as DisbursementJobStatus,
    totalChunks: 1,
    completedChunks: 0,
    startedAt: new Date(),
    completedAt: null as Date | null,
    createdAt: new Date(),
  };

  const chunk = {
    id: "chk-1",
    jobId: "job-1",
    sourceAccountId: "acc-1",
    recipientUsername: "suzillious|target_123",
    amount: "100000000000",
    idempotencyKey: "disb_job1_c1_main_treasury",
    status: DisbursementChunkStatus.PENDING as DisbursementChunkStatus,
    attemptCount: 0,
    httpStatus: null as number | null,
    errorMessage: null as string | null,
    reconciliationNote: null as string | null,
    executedAt: null as Date | null,
    createdAt: new Date(),
  };

  const txPrisma = {
    disbursementJob: {
      findUnique: async () => ({ ...job, chunks: [chunk] }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return job;
      },
    },
    disbursementChunk: {
      findUnique: async () => chunk,
      findMany: async () => [chunk],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (
          data.attemptCount &&
          typeof data.attemptCount === "object" &&
          "increment" in data.attemptCount
        ) {
          chunk.attemptCount += Number((data.attemptCount as { increment: number }).increment);
          const rest = { ...data };
          delete rest.attemptCount;
          Object.assign(chunk, rest);
        } else {
          Object.assign(chunk, data);
        }
        return chunk;
      },
    },
    gameAccount: {
      findUnique: async () => account,
      findMany: async () => [account],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(account, data);
        return account;
      },
    },
    order: {
      findUnique: async () => order,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(order, data);
        return order;
      },
    },
    inventoryReservation: {
      findMany: async () => order.reservations,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(order.reservations[0]!, data);
        return order.reservations[0]!;
      },
    },
    inventoryLedger: { create: async () => ({}) },
    customer: { findUnique: async () => ({ userId: "cust-user-1" }) },
    notification: { create: async () => ({}) },
    auditLog: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txPrisma),
  } as unknown as ConstructorParameters<typeof DisbursementService>[0];

  const disb = new DisbursementService(txPrisma, TEST_KEY, adapter, {
    disbursementEnabled: true,
    nowFn: () => nowMs,
  });

  // 1. Missing PIN pauses job cleanly without terminal failure
  let step = await disb.processJobStepForWorker({ jobId: "job-1", actorUserId: "owner-1" });
  assert.equal(step.nextDelayMs, null);
  assert.equal(job.status, DisbursementJobStatus.PAUSED);
  assert.equal(chunk.status, DisbursementChunkStatus.FAILED_RETRYABLE);
  assert.ok(chunk.errorMessage?.startsWith("PIN_REQUIRED:MAIN_TREASURY:"));

  // 2. Rotate encrypted PIN to wrong PIN -> resumes -> still pauses as PIN_REQUIRED
  account.encryptedSessionBundle = encodeEncryptedSessionBundle(
    {
      cookie: "ll_session=mock_cookie",
      uid: "u1",
      username: "bigola2823",
      simName: "teslim__",
      connectedAt: "2026-11-16T00:00:00.000Z",
      verifiedAt: "2026-11-16T00:00:00.000Z",
      transactionPin: "0000",
      pinUpdatedAt: new Date().toISOString(),
    },
    TEST_KEY
  );
  await disb.resumeJob({ jobId: "job-1", actorUserId: "owner-1", actorRole: UserRole.OWNER });
  job.status = DisbursementJobStatus.RUNNING;
  mode = "WRONG_PIN";
  step = await disb.processJobStepForWorker({ jobId: "job-1", actorUserId: "owner-1" });
  assert.equal(job.status, DisbursementJobStatus.PAUSED);
  assert.ok(chunk.errorMessage?.startsWith("PIN_REQUIRED:MAIN_TREASURY:"));

  // 3. Correct PIN, 2FA required -> pauses with TWO_FACTOR_REQUIRED
  account.encryptedSessionBundle = encodeEncryptedSessionBundle(
    {
      cookie: "ll_session=mock_cookie",
      uid: "u1",
      username: "bigola2823",
      simName: "teslim__",
      connectedAt: "2026-11-16T00:00:00.000Z",
      verifiedAt: "2026-11-16T00:00:00.000Z",
      transactionPin: "7788",
      pinUpdatedAt: new Date().toISOString(),
    },
    TEST_KEY
  );
  await disb.resumeJob({ jobId: "job-1", actorUserId: "owner-1", actorRole: UserRole.OWNER });
  job.status = DisbursementJobStatus.RUNNING;
  mode = "NEED_2FA";
  nowMs += 31_000;
  step = await disb.processJobStepForWorker({ jobId: "job-1", actorUserId: "owner-1" });
  assert.equal(job.status, DisbursementJobStatus.PAUSED);
  assert.ok(chunk.errorMessage?.startsWith("TWO_FACTOR_REQUIRED:MAIN_TREASURY:"));

  // 4. Resume with one-time 2FA code -> sends pin + code + twoStep and completes!
  await disb.resumeJob({
    jobId: "job-1",
    actorUserId: "owner-1",
    actorRole: UserRole.OWNER,
    twoFactorCode: "654321",
    slotCode: "MAIN_TREASURY",
  });
  job.status = DisbursementJobStatus.RUNNING;
  mode = "SUCCEED";
  step = await disb.processJobStepForWorker({ jobId: "job-1", actorUserId: "owner-1" });
  assert.equal(chunk.status, DisbursementChunkStatus.SUCCEEDED);
  assert.equal(job.status, DisbursementJobStatus.COMPLETED);
  const lastSent = sentPayloads[sentPayloads.length - 1]!;
  assert.equal(lastSent.body.pin, "7788");
  assert.equal(lastSent.body.code, "654321");
  assert.equal(lastSent.body.twoStep, "654321");
  assert.equal(lastSent.idempotencyKey, "disb_job1_c1_main_treasury");
});

test("Stage 19.3: HTTP 401 on /api/send pauses job (409 on Execute), and reconnecting session updates bundle for resume", async () => {
  const seenCookies: string[] = [];
  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    const hdrs = (init?.headers ?? {}) as Record<string, string>;
    if (u.endsWith("/api/save")) {
      return new Response(
        JSON.stringify({ game: { money: "500000000000", sim: { name: "Miles Peter" }, owner: "u4" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.endsWith("/api/send")) {
      seenCookies.push(hdrs.cookie ?? "");
      if (hdrs.cookie === "ll_session=stale_cookie") {
        return new Response(JSON.stringify({ error: "Unauthorized session" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  };

  const adapter = new LagosLifeAdapter({ fetchImpl: mockFetch });
  const account = {
    id: "acc-4",
    slotCode: "RESERVE_4",
    lagoslifeUsername: "milespete",
    healthStatus: GameAccountHealth.ACTIVE,
    lastKnownBalance: "500000000000",
    reservedForOrders: "100000000000",
    encryptedSessionBundle: encodeEncryptedSessionBundle(
      {
        cookie: "ll_session=stale_cookie",
        uid: "u4",
        username: "milespete",
        simName: "Miles Peter",
        connectedAt: "2026-11-16T00:00:00.000Z",
        verifiedAt: "2026-11-16T00:00:00.000Z",
        transactionPin: null,
        pinUpdatedAt: null,
      },
      TEST_KEY
    ),
  };

  const order = {
    id: "ord-401",
    orderNumber: "ORD-401-TEST",
    customerId: "cust-1",
    recipientLagoslifeUsername: "kuronox",
    status: OrderStatus.DISBURSING,
    gameAmountRequested: "100000000000",
    gameAmountDelivered: "0",
    fulfilledAmount: "0",
    reservations: [
      {
        id: "res-401",
        orderId: "ord-401",
        gameAccountId: "acc-4",
        amount: "100000000000",
        status: InventoryReservationStatus.ACTIVE,
      },
    ],
  };

  const job = {
    id: "job-401",
    orderId: "ord-401",
    totalAmount: "100000000000",
    deliveredAmount: "0",
    status: DisbursementJobStatus.RUNNING as DisbursementJobStatus,
    totalChunks: 1,
    completedChunks: 0,
    startedAt: new Date(),
    completedAt: null as Date | null,
    createdAt: new Date(),
  };

  const chunk = {
    id: "chk-401",
    jobId: "job-401",
    sourceAccountId: "acc-4",
    recipientUsername: "kuronox|target_k",
    amount: "100000000000",
    idempotencyKey: "disb_job401_c1_reserve_4",
    status: DisbursementChunkStatus.PENDING as DisbursementChunkStatus,
    attemptCount: 0,
    httpStatus: null as number | null,
    errorMessage: null as string | null,
    reconciliationNote: null as string | null,
    executedAt: null as Date | null,
    createdAt: new Date(),
  };

  const txPrisma = {
    disbursementJob: {
      findUnique: async () => ({ ...job, chunks: [chunk] }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return job;
      },
    },
    disbursementChunk: {
      findUnique: async () => chunk,
      findMany: async () => [chunk],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.attemptCount && typeof data.attemptCount === "object" && "increment" in data.attemptCount) {
          chunk.attemptCount += Number((data.attemptCount as { increment: number }).increment);
          const rest = { ...data };
          delete rest.attemptCount;
          Object.assign(chunk, rest);
        } else {
          Object.assign(chunk, data);
        }
        return chunk;
      },
    },
    gameAccount: {
      findUnique: async () => account,
      findMany: async () => [account],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(account, data);
        return account;
      },
    },
    order: {
      findUnique: async () => order,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(order, data);
        return order;
      },
    },
    inventoryReservation: {
      findMany: async () => order.reservations,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(order.reservations[0]!, data);
        return order.reservations[0]!;
      },
    },
    inventoryLedger: { create: async () => ({}) },
    customer: { findUnique: async () => ({ userId: "cust-user-1" }) },
    notification: { create: async () => ({}) },
    auditLog: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txPrisma),
  } as unknown as ConstructorParameters<typeof DisbursementService>[0];

  const disb = new DisbursementService(txPrisma, TEST_KEY, adapter, {
    disbursementEnabled: true,
  });

  // 1. Stale cookie returns 401 -> pauses job & preserves upstream error message
  const step1 = await disb.processJobStepForWorker({ jobId: "job-401", actorUserId: "owner-1" });
  assert.equal(step1.nextDelayMs, null);
  assert.equal(job.status, DisbursementJobStatus.PAUSED);
  assert.equal(account.healthStatus, GameAccountHealth.SESSION_EXPIRED);
  assert.equal(chunk.status, DisbursementChunkStatus.FAILED_RETRYABLE);
  assert.equal(chunk.attemptCount, 1);
  assert.ok(chunk.errorMessage?.includes("HTTP 401): Unauthorized session"));

  // 2. Calling prepareJobForQueuedExecution (Execute) while PAUSED throws 409 DISBURSEMENT_JOB_PAUSED
  await assert.rejects(
    () => disb.prepareJobForQueuedExecution({ jobId: "job-401", actorUserId: "owner-1", actorRole: UserRole.OWNER }),
    (err: unknown) => (err as { statusCode?: number; code?: string }).statusCode === 409 && (err as { code?: string }).code === "DISBURSEMENT_JOB_PAUSED"
  );

  // 3. Reconnect session on account -> resume -> execute succeeds with new cookie
  account.healthStatus = GameAccountHealth.ACTIVE;
  account.encryptedSessionBundle = encodeEncryptedSessionBundle(
    {
      cookie: "ll_session=fresh_cookie",
      uid: "u4",
      username: "milespete",
      simName: "Miles Peter",
      connectedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      transactionPin: null,
      pinUpdatedAt: null,
    },
    TEST_KEY
  );
  await disb.resumeJob({ jobId: "job-401", actorUserId: "owner-1", actorRole: UserRole.OWNER });
  await disb.prepareJobForQueuedExecution({ jobId: "job-401", actorUserId: "owner-1", actorRole: UserRole.OWNER });
  const step2 = await disb.processJobStepForWorker({ jobId: "job-401", actorUserId: "owner-1" });
  assert.equal(step2.nextDelayMs, null);
  assert.equal(chunk.status, DisbursementChunkStatus.SUCCEEDED);
  assert.equal(job.status, DisbursementJobStatus.COMPLETED);
  assert.deepEqual(seenCookies, ["ll_session=stale_cookie", "ll_session=fresh_cookie"]);
});

test("Stage 19.4: Reconnect preserves PIN, clearing PIN triggers PIN_REQUIRED, and re-saving PIN + Resume succeeds", async () => {
  const sentPins: Array<string | null> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/auth/me")) {
      return new Response(
        JSON.stringify({ user: { id: "u4", username: "milespete", name: "Miles Peter" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.endsWith("/api/save")) {
      return new Response(
        JSON.stringify({ game: { money: "500000000000", sim: { name: "Miles Peter" }, owner: "u4" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.endsWith("/api/send")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { pin?: string };
      sentPins.push(body.pin ?? null);
      if (!body.pin) {
        return new Response(JSON.stringify({ error: "Enter your transaction PIN to send" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  };

  const adapter = new LagosLifeAdapter({ fetchImpl: mockFetch });
  const account = {
    id: "acc-4",
    slotCode: "RESERVE_4",
    lagoslifeUsername: "milespete",
    accountRole: GameAccountRole.RESERVE,
    healthStatus: GameAccountHealth.ACTIVE,
    lastKnownBalance: { toFixed: () => "500000000000" },
    reservedForOrders: { toFixed: () => "100000000000" },
    lastSyncedAt: new Date(),
    encryptedSessionBundle: encodeEncryptedSessionBundle(
      {
        cookie: "ll_session=cookie_1",
        uid: "u4",
        username: "milespete",
        simName: "Miles Peter",
        connectedAt: "2026-11-16T00:00:00.000Z",
        verifiedAt: "2026-11-16T00:00:00.000Z",
        transactionPin: null,
        pinUpdatedAt: null,
      },
      TEST_KEY
    ),
  };

  const order = {
    id: "ord-pin-flow",
    orderNumber: "ORD-PIN-FLOW",
    customerId: "cust-1",
    recipientLagoslifeUsername: "kuronox",
    status: OrderStatus.DISBURSING,
    gameAmountRequested: "100000000000",
    gameAmountDelivered: "0",
    fulfilledAmount: "0",
    reservations: [
      {
        id: "res-pin-1",
        orderId: "ord-pin-flow",
        gameAccountId: "acc-4",
        amount: "100000000000",
        status: InventoryReservationStatus.ACTIVE,
      },
    ],
  };

  const job = {
    id: "job-pin-flow",
    orderId: "ord-pin-flow",
    totalAmount: "100000000000",
    deliveredAmount: "0",
    status: DisbursementJobStatus.RUNNING as DisbursementJobStatus,
    totalChunks: 1,
    completedChunks: 0,
    startedAt: new Date(),
    completedAt: null as Date | null,
    createdAt: new Date(),
  };

  const chunk = {
    id: "chk-pin-flow",
    jobId: "job-pin-flow",
    sourceAccountId: "acc-4",
    recipientUsername: "kuronox|target_k",
    amount: "100000000000",
    idempotencyKey: "disb_jobpin_c1_reserve_4",
    status: DisbursementChunkStatus.PENDING as DisbursementChunkStatus,
    attemptCount: 0,
    httpStatus: null as number | null,
    errorMessage: null as string | null,
    reconciliationNote: null as string | null,
    executedAt: null as Date | null,
    createdAt: new Date(),
  };

  const txPrisma = {
    disbursementJob: {
      findUnique: async () => ({ ...job, chunks: [chunk] }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return job;
      },
    },
    disbursementChunk: {
      findUnique: async () => chunk,
      findMany: async () => [chunk],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.attemptCount && typeof data.attemptCount === "object" && "increment" in data.attemptCount) {
          chunk.attemptCount += Number((data.attemptCount as { increment: number }).increment);
          const rest = { ...data };
          delete rest.attemptCount;
          Object.assign(chunk, rest);
        } else {
          Object.assign(chunk, data);
        }
        return chunk;
      },
    },
    gameAccount: {
      findUnique: async () => account,
      findFirst: async () => null,
      findMany: async () => [account],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(account, {
          ...data,
          ...(typeof data.lastKnownBalance === "string"
            ? { lastKnownBalance: { toFixed: () => data.lastKnownBalance as string } }
            : {}),
          ...(typeof data.reservedForOrders === "string"
            ? { reservedForOrders: { toFixed: () => data.reservedForOrders as string } }
            : {}),
        });
        return account;
      },
    },
    order: {
      findUnique: async () => order,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(order, data);
        return order;
      },
    },
    inventoryReservation: {
      findMany: async () => order.reservations,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(order.reservations[0]!, data);
        return order.reservations[0]!;
      },
    },
    inventoryLedger: { findMany: async () => [], create: async () => ({}) },
    customer: { findUnique: async () => ({ userId: "cust-user-1" }) },
    notification: { create: async () => ({}), createMany: async () => ({ count: 0 }) },
    user: { findMany: async () => [] },
    auditLog: { create: async () => ({}) },
    $queryRaw: async () => [
      {
        id: "acc-4",
        slot_code: "RESERVE_4",
        last_known_balance: account.lastKnownBalance.toFixed(),
        reserved_for_orders: account.reservedForOrders.toFixed(),
        health_status: account.healthStatus,
        last_synced_at: account.lastSyncedAt,
      },
    ],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txPrisma),
  } as unknown as ConstructorParameters<typeof DisbursementService>[0];

  const inv = new InventoryService(txPrisma as unknown as ConstructorParameters<typeof InventoryService>[0], {
    encryptionKeyHex: TEST_KEY,
    lagosLifeAdapter: adapter,
  });
  const disb = new DisbursementService(txPrisma, TEST_KEY, adapter, { disbursementEnabled: true });

  // 1. Set PIN, then reconnect session -> PIN is preserved
  await inv.setAccountTransactionPin({ actorUserId: "owner-1", slotCode: "RESERVE_4", pin: "2468" });
  await inv.importSlotCookie({ actorUserId: "owner-1", slotCode: "RESERVE_4", cookie: "ll_session=cookie_2" });
  assert.equal(decodeEncryptedSessionBundle(account.encryptedSessionBundle, TEST_KEY)?.transactionPin, "2468");

  // 2. Clear PIN -> executing triggers PIN_REQUIRED:RESERVE_4:Enter your transaction PIN to send
  await inv.clearAccountTransactionPin({ actorUserId: "owner-1", slotCode: "RESERVE_4" });
  const step1 = await disb.processJobStepForWorker({ jobId: "job-pin-flow", actorUserId: "owner-1" });
  assert.equal(step1.nextDelayMs, null);
  assert.equal(job.status, DisbursementJobStatus.PAUSED);
  assert.equal(chunk.errorMessage, "PIN_REQUIRED:RESERVE_4:Enter your transaction PIN to send");

  // 3. Re-configure PIN + Resume + Execute -> sends PIN and completes
  await inv.setAccountTransactionPin({ actorUserId: "owner-1", slotCode: "RESERVE_4", pin: "2468" });
  await disb.resumeJob({ jobId: "job-pin-flow", actorUserId: "owner-1", actorRole: UserRole.OWNER });
  await disb.prepareJobForQueuedExecution({ jobId: "job-pin-flow", actorUserId: "owner-1", actorRole: UserRole.OWNER });
  const step2 = await disb.processJobStepForWorker({ jobId: "job-pin-flow", actorUserId: "owner-1" });
  assert.equal(step2.nextDelayMs, null);
  assert.equal(job.status, DisbursementJobStatus.COMPLETED);
  assert.deepEqual(sentPins, [null, "2468"]);
});

test("Stage 19.5: Slow/failed DB commit after HTTP 200 pauses as AMBIGUOUS_MANUAL_REVIEW without retry, and reconciliation is idempotent", async () => {
  let sendCount = 0;
  let ledgerDebits = 0;
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/api/save")) {
      return new Response(
        JSON.stringify({ game: { money: "500000000000", sim: { name: "Miles Peter" }, owner: "u4" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.endsWith("/api/send")) {
      sendCount++;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  };

  const adapter = new LagosLifeAdapter({ fetchImpl: mockFetch });
  const account = {
    id: "acc-4",
    slotCode: "RESERVE_4",
    lagoslifeUsername: "milespete",
    healthStatus: GameAccountHealth.ACTIVE,
    lastKnownBalance: "500000000000",
    reservedForOrders: "200000000000",
    encryptedSessionBundle: encodeEncryptedSessionBundle(
      {
        cookie: "ll_session=cookie_ok",
        uid: "u4",
        username: "milespete",
        simName: "Miles Peter",
        connectedAt: "2026-11-16T00:00:00.000Z",
        verifiedAt: "2026-11-16T00:00:00.000Z",
        transactionPin: "2468",
        pinUpdatedAt: "2026-11-16T00:00:00.000Z",
      },
      TEST_KEY
    ),
  };

  const order = {
    id: "ord-p2028",
    orderNumber: "ORD-P2028",
    customerId: "cust-1",
    recipientLagoslifeUsername: "kuronox",
    status: OrderStatus.DISBURSING,
    gameAmountRequested: "200000000000",
    gameAmountDelivered: "0",
    fulfilledAmount: "0",
    reservations: [
      {
        id: "res-p2028",
        orderId: "ord-p2028",
        gameAccountId: "acc-4",
        amount: "200000000000",
        status: InventoryReservationStatus.ACTIVE,
      },
    ],
  };

  const job = {
    id: "job-p2028",
    orderId: "ord-p2028",
    totalAmount: "200000000000",
    deliveredAmount: "0",
    status: DisbursementJobStatus.RUNNING as DisbursementJobStatus,
    totalChunks: 2,
    completedChunks: 0,
    startedAt: new Date(),
    completedAt: null as Date | null,
    createdAt: new Date(),
  };

  const chunks = [
    {
      id: "chk-p2028-1",
      jobId: "job-p2028",
      sourceAccountId: "acc-4",
      recipientUsername: "kuronox|target_k",
      amount: "100000000000",
      idempotencyKey: "disb_p2028_c1_reserve_4",
      status: DisbursementChunkStatus.PENDING as DisbursementChunkStatus,
      attemptCount: 0,
      httpStatus: null as number | null,
      errorMessage: null as string | null,
      reconciliationNote: null as string | null,
      executedAt: null as Date | null,
      createdAt: new Date(),
    },
    {
      id: "chk-p2028-2",
      jobId: "job-p2028",
      sourceAccountId: "acc-4",
      recipientUsername: "kuronox|target_k",
      amount: "100000000000",
      idempotencyKey: "disb_p2028_c2_reserve_4",
      status: DisbursementChunkStatus.PENDING as DisbursementChunkStatus,
      attemptCount: 0,
      httpStatus: null as number | null,
      errorMessage: null as string | null,
      reconciliationNote: null as string | null,
      executedAt: null as Date | null,
      createdAt: new Date(),
    },
  ];

  let failFirstCommitWithP2028 = true;
  let seenTxOptions: unknown = null;

  const txPrisma = {
    disbursementJob: {
      findUnique: async () => ({ ...job, chunks }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return job;
      },
    },
    disbursementChunk: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        chunks.find((c) => c.id === where.id) ?? null,
      findMany: async () => chunks,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const target = chunks.find((c) => c.id === where.id)!;
        if (data.attemptCount && typeof data.attemptCount === "object" && "increment" in data.attemptCount) {
          target.attemptCount += Number((data.attemptCount as { increment: number }).increment);
          const rest = { ...data };
          delete rest.attemptCount;
          Object.assign(target, rest);
        } else {
          Object.assign(target, data);
        }
        return target;
      },
    },
    gameAccount: {
      findUnique: async () => account,
      findMany: async () => [account],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(account, data);
        return account;
      },
    },
    order: {
      findUnique: async () => order,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(order, data);
        return order;
      },
    },
    inventoryReservation: {
      findMany: async () => order.reservations,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(order.reservations[0]!, data);
        return order.reservations[0]!;
      },
    },
    inventoryLedger: {
      create: async ({ data }: { data: { entryType?: string } }) => {
        if (data.entryType === "DISBURSEMENT_DEBIT") ledgerDebits++;
        return {};
      },
    },
    customer: { findUnique: async () => ({ userId: "cust-user-1" }) },
    notification: { create: async () => ({}) },
    auditLog: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
      seenTxOptions = opts ?? null;
      if (failFirstCommitWithP2028) {
        failFirstCommitWithP2028 = false;
        throw new Error("Transaction already closed (P2028 simulated timeout)");
      }
      return fn(txPrisma);
    },
  } as unknown as ConstructorParameters<typeof DisbursementService>[0];

  let nowMs = 1_700_000_000_000;
  const disb = new DisbursementService(txPrisma, TEST_KEY, adapter, {
    disbursementEnabled: true,
    nowFn: () => nowMs,
  });

  // 1. Upstream /api/send succeeds, DB commit fails with P2028 -> pauses as AMBIGUOUS_MANUAL_REVIEW
  const step1 = await disb.processJobStepForWorker({ jobId: "job-p2028", actorUserId: "owner-1" });
  assert.equal(step1.nextDelayMs, null);
  assert.equal(sendCount, 1);
  assert.equal(job.status, DisbursementJobStatus.PAUSED);
  assert.equal(chunks[0]!.status, DisbursementChunkStatus.AMBIGUOUS_MANUAL_REVIEW);
  assert.equal(job.deliveredAmount, "0");
  assert.deepEqual(seenTxOptions, { maxWait: 10_000, timeout: 30_000 });

  // 2. Cooldown (30.5s) was still recorded
  const remainingCd = await disb.coordinator.getRemainingCooldownMs(account.id);
  assert.equal(remainingCd, 30_500);

  // 3. Owner resolves Chunk #1 as CONFIRMED_DELIVERED -> records 100B once
  await disb.resolveAmbiguousChunk({
    jobId: "job-p2028",
    chunkId: "chk-p2028-1",
    outcome: "CONFIRMED_DELIVERED",
    notes: "Verified recipient received 100B",
    actorUserId: "owner-1",
    actorRole: UserRole.OWNER,
  });
  assert.equal(chunks[0]!.status, DisbursementChunkStatus.SUCCEEDED);
  assert.equal(job.deliveredAmount, "100000000000");
  assert.equal(job.completedChunks, 1);
  assert.equal(ledgerDebits, 1);

  // 4. Attempting to commit the already-SUCCEEDED chunk again is a no-op (zero duplicate debit)
  await (disb as unknown as {
    commitConfirmedChunkDelivery: (p: Record<string, unknown>) => Promise<void>;
  }).commitConfirmedChunkDelivery({
    jobId: "job-p2028",
    orderId: "ord-p2028",
    chunkId: "chk-p2028-1",
    accountId: "acc-4",
    chunkAmount: 100_000_000_000n,
    httpStatus: 200,
    reconciliationNote: "Duplicate call check",
  });
  assert.equal(ledgerDebits, 1);
  assert.equal(job.deliveredAmount, "100000000000");

  // 5. Resume while still on cooldown -> schedules delayed pass (~30.5s), then after cooldown sends Chunk #2
  await disb.resumeJob({ jobId: "job-p2028", actorUserId: "owner-1", actorRole: UserRole.OWNER });
  await disb.prepareJobForQueuedExecution({ jobId: "job-p2028", actorUserId: "owner-1", actorRole: UserRole.OWNER });
  const stepCooldown = await disb.processJobStepForWorker({ jobId: "job-p2028", actorUserId: "owner-1" });
  assert.ok((stepCooldown.nextDelayMs ?? 0) >= 30_000);
  assert.equal(sendCount, 1); // Did NOT bypass cooldown!

  nowMs += 31_000;
  const step2 = await disb.processJobStepForWorker({ jobId: "job-p2028", actorUserId: "owner-1" });
  assert.equal(step2.nextDelayMs, null);
  assert.equal(sendCount, 2);
  assert.equal(job.status, DisbursementJobStatus.COMPLETED);
  assert.equal(job.deliveredAmount, "200000000000");
});
