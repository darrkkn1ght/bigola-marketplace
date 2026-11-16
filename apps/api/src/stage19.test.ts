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
