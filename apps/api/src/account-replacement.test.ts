import assert from "node:assert/strict";
import test from "node:test";
import {
  GameAccountHealth,
  GameAccountRole,
} from "@prisma/client";
import { InventoryError, InventoryService } from "./services/inventory.js";
import {
  decodeEncryptedSessionBundle,
  encodeEncryptedSessionBundle,
  LagosLifeAdapter,
} from "./services/lagoslife.js";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function createReplacementHarness() {
  const accounts = new Map<string, Record<string, unknown>>([
    [
      "MAIN_TREASURY",
      {
        id: "acc-main",
        slotCode: "MAIN_TREASURY",
        lagoslifeUsername: "bigola2823",
        accountRole: GameAccountRole.MAIN_TREASURY,
        healthStatus: GameAccountHealth.ACTIVE,
        lastKnownBalance: "50000000000000",
        reservedForOrders: "0",
        targetReserveAmount: "0",
        logicalAllocationAmount: "0",
        lastSyncedAt: new Date(),
        encryptedSessionBundle: encodeEncryptedSessionBundle(
          {
            cookie: "ll_session=main_secret",
            uid: "u-main",
            username: "bigola2823",
            simName: "teslim__",
            connectedAt: "2026-11-16T00:00:00.000Z",
            verifiedAt: "2026-11-16T00:00:00.000Z",
            transactionPin: "1111",
            pinUpdatedAt: "2026-11-16T00:00:00.000Z",
          },
          TEST_KEY
        ),
      },
    ],
    [
      "RESERVE_1",
      {
        id: "acc-res1",
        slotCode: "RESERVE_1",
        lagoslifeUsername: "old_reserve_user",
        accountRole: GameAccountRole.RESERVE,
        healthStatus: GameAccountHealth.ACTIVE,
        lastKnownBalance: "10000000000000",
        reservedForOrders: "0",
        targetReserveAmount: "70000000000000",
        logicalAllocationAmount: "0",
        lastSyncedAt: new Date(),
        encryptedSessionBundle: encodeEncryptedSessionBundle(
          {
            cookie: "ll_session=old_secret_cookie",
            uid: "u-old",
            username: "old_reserve_user",
            simName: "OldReserve",
            connectedAt: "2026-11-16T00:00:00.000Z",
            verifiedAt: "2026-11-16T00:00:00.000Z",
            transactionPin: "9876",
            pinUpdatedAt: "2026-11-16T00:00:00.000Z",
          },
          TEST_KEY
        ),
      },
    ],
  ]);

  let activeReservationCount = 0;
  let activeChunkCount = 0;
  const historicalLedger = [{ id: "led-1", gameAccountId: "acc-res1", deltaAmount: "-100000000000" }];
  const historicalChunks = [{ id: "chk-hist-1", sourceAccountId: "acc-res1", status: "SUCCEEDED" }];
  const auditLogs: Array<Record<string, unknown>> = [];

  const mockPrisma = {
    gameAccount: {
      findUnique: async ({ where }: { where: { slotCode?: string; id?: string } }) => {
        const acc = where.slotCode
          ? accounts.get(where.slotCode)
          : [...accounts.values()].find((a) => a.id === where.id);
        if (!acc) return null;
        return {
          ...acc,
          lastKnownBalance: { toFixed: () => String(acc.lastKnownBalance) },
          reservedForOrders: { toFixed: () => String(acc.reservedForOrders) },
        };
      },
      findFirst: async ({
        where,
      }: {
        where: { lagoslifeUsername?: { equals: string }; NOT?: { id: string } };
      }) => {
        const target = where.lagoslifeUsername?.equals?.toLowerCase();
        const found = [...accounts.values()].find(
          (a) =>
            typeof a.lagoslifeUsername === "string" &&
            a.lagoslifeUsername.toLowerCase() === target &&
            a.id !== where.NOT?.id
        );
        return found ? { slotCode: found.slotCode } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const acc = [...accounts.values()].find((a) => a.id === where.id)!;
        Object.assign(acc, data);
        return {
          ...acc,
          lastKnownBalance: { toFixed: () => String(acc.lastKnownBalance) },
          reservedForOrders: { toFixed: () => String(acc.reservedForOrders) },
        };
      },
    },
    inventoryReservation: {
      count: async () => activeReservationCount,
    },
    disbursementChunk: {
      count: async () => activeChunkCount,
    },
    inventoryDiscrepancy: {
      create: async () => ({ id: "disc-1" }),
    },
    inventoryLedger: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        historicalLedger.push({
          id: `led-${historicalLedger.length + 1}`,
          gameAccountId: String(data.gameAccountId),
          deltaAmount: String(data.deltaAmount),
        });
        return data;
      },
      aggregate: async () => ({ _sum: { deltaAmount: null } }),
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditLogs.push(data);
        return data;
      },
    },
    notification: { createMany: async () => ({ count: 0 }) },
    user: { findMany: async () => [] },
    $queryRaw: async () => [
      {
        id: "acc-res1",
        slot_code: "RESERVE_1",
        last_known_balance: String(accounts.get("RESERVE_1")!.lastKnownBalance),
        reserved_for_orders: String(accounts.get("RESERVE_1")!.reservedForOrders),
        health_status: String(accounts.get("RESERVE_1")!.healthStatus),
        last_synced_at: accounts.get("RESERVE_1")!.lastSyncedAt,
      },
    ],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma),
  } as unknown as ConstructorParameters<typeof InventoryService>[0];

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/api/auth/me")) {
      return new Response(
        JSON.stringify({ user: { id: "u-new", username: "new_reserve_user", name: "NewReserve" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.endsWith("/api/save")) {
      return new Response(
        JSON.stringify({ game: { money: "25000000000000", sim: { name: "NewReserve" }, owner: "u-new" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("{}", { status: 404 });
  };

  const adapter = new LagosLifeAdapter({ fetchImpl: mockFetch });
  const inv = new InventoryService(mockPrisma, {
    encryptionKeyHex: TEST_KEY,
    lagosLifeAdapter: adapter,
  });

  return {
    inv,
    accounts,
    auditLogs,
    historicalLedger,
    historicalChunks,
    setActiveReservationCount: (n: number) => {
      activeReservationCount = n;
    },
    setActiveChunkCount: (n: number) => {
      activeChunkCount = n;
    },
  };
}

test("Account Replacement 1: Rejects MAIN_TREASURY and blocked conditions (reservations, chunks, locks)", async () => {
  const h = createReplacementHarness();

  await assert.rejects(
    () =>
      h.inv.replaceReserveAccount({
        actorUserId: "owner-1",
        slotCode: "MAIN_TREASURY",
        reason: "Attempt replace main",
      }),
    (err: unknown) => err instanceof InventoryError && err.code === "MAIN_TREASURY_REPLACEMENT_FORBIDDEN"
  );

  await assert.rejects(
    () =>
      h.inv.replaceReserveAccount({
        actorUserId: "owner-1",
        slotCode: "RESERVE_1",
        reason: "Locked account",
        isAccountLockedFn: async () => true,
      }),
    (err: unknown) => err instanceof InventoryError && err.code === "ACCOUNT_TRANSFER_LOCK_ACTIVE"
  );

  h.setActiveReservationCount(1);
  await assert.rejects(
    () =>
      h.inv.replaceReserveAccount({
        actorUserId: "owner-1",
        slotCode: "RESERVE_1",
        reason: "Has reservation",
      }),
    (err: unknown) => err instanceof InventoryError && err.code === "ACTIVE_RESERVATIONS_EXIST"
  );
  h.setActiveReservationCount(0);

  h.setActiveChunkCount(2);
  await assert.rejects(
    () =>
      h.inv.replaceReserveAccount({
        actorUserId: "owner-1",
        slotCode: "RESERVE_1",
        reason: "Has chunks",
      }),
    (err: unknown) => err instanceof InventoryError && err.code === "ACTIVE_DISBURSEMENT_CHUNKS_EXIST"
  );
});

test("Account Replacement 2: Clears old credentials, preserves history/audit logs, and connects verified replacement", async () => {
  const h = createReplacementHarness();

  const res = await h.inv.replaceReserveAccount({
    actorUserId: "owner-1",
    slotCode: "RESERVE_1",
    reason: "Replacing reserve slot 1 wallet",
    isAccountLockedFn: async () => false,
  });

  assert.equal(res.replaced, true);
  assert.equal(res.healthStatus, GameAccountHealth.UNCONFIGURED);
  assert.equal(res.lagoslifeUsername, null);
  assert.equal(res.hasPin, false);

  const slot = h.accounts.get("RESERVE_1")!;
  assert.equal(slot.encryptedSessionBundle, null);
  assert.equal(slot.lagoslifeUsername, null);
  assert.equal(slot.healthStatus, GameAccountHealth.UNCONFIGURED);

  // Historical records preserved
  assert.equal(h.historicalChunks.length, 1);
  assert.equal(h.historicalLedger[0]!.id, "led-1");

  // Audit log recorded without exposing secrets
  const replaceLog = h.auditLogs.find((l) => l.actionType === "LAGOSLIFE_ACCOUNT_REPLACED");
  assert.ok(replaceLog);
  assert.equal(JSON.stringify(h.auditLogs).includes("old_secret_cookie"), false);
  assert.equal(JSON.stringify(h.auditLogs).includes("9876"), false);

  // Connect new verified LagosLife account via existing flow
  const connected = await h.inv.importSlotCookie({
    actorUserId: "owner-1",
    slotCode: "RESERVE_1",
    cookie: "ll_session=new_verified_cookie",
  });
  assert.equal(connected.lagoslifeUsername, "new_reserve_user");
  assert.equal(connected.healthStatus, GameAccountHealth.ACTIVE);
  assert.equal(
    decodeEncryptedSessionBundle(slot.encryptedSessionBundle as string, TEST_KEY)?.transactionPin,
    null
  );
});
