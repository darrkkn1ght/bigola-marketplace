import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GameAccountHealth, GameAccountRole, InventoryEntryType, PrismaClient, UserRole } from "@prisma/client";
import { ONE_TRILLION } from "@bigola/shared";
import { encryptSensitiveValue, hashPassword } from "./lib/crypto.js";
import { loadIsolatedTestEnv } from "./lib/test-isolation.js";
import { InventoryError, InventoryService } from "./services/inventory.js";
import type { LagosLifeAdapter } from "./services/lagoslife.js";

const RUN_INFRA = process.env.RUN_INFRA_TESTS === "true";

describe("P2 Dynamic Reserve Accounts & Main Treasury Refill", { skip: !RUN_INFRA }, () => {
  it("creates dynamic reserve slot, blocks refill when disabled, executes 100B chunked refill, and halts on ambiguous outcome", async () => {
    const env = loadIsolatedTestEnv();
    const prisma = new PrismaClient();
    const runId = Date.now().toString(36).toUpperCase();
    const testSlotCode = `RESERVE_P2_${runId.slice(-6)}`;

    const origTreasury = await prisma.gameAccount.findUnique({ where: { slotCode: "MAIN_TREASURY" } });
    let createdReserveId: string | null = null;
    let createdOwnerId: string | null = null;

    try {
      const owner = await prisma.user.create({
        data: {
          email: `owner-p2-${runId.toLowerCase()}@bigola.test`,
          passwordHash: await hashPassword("OwnerPass123!"),
          role: UserRole.OWNER,
          isActive: true,
        },
      });
      createdOwnerId = owner.id;

      const treasurySession = encryptSensitiveValue(
        JSON.stringify({
          cookie: "ll_session=treasury_test",
          uid: "uid_treasury",
          username: "bigola2823",
          simName: "Big Ola Treasury",
          connectedAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          transactionPin: "1234",
        }),
        env.ENCRYPTION_KEY_HEX
      );
      await prisma.gameAccount.upsert({
        where: { slotCode: "MAIN_TREASURY" },
        update: {
          healthStatus: GameAccountHealth.ACTIVE,
          lastKnownBalance: (10n * ONE_TRILLION).toString(),
          reservedForOrders: "0",
          lastSyncedAt: new Date(),
          encryptedSessionBundle: treasurySession,
        },
        create: {
          slotCode: "MAIN_TREASURY",
          accountRole: GameAccountRole.MAIN_TREASURY,
          lagoslifeUsername: "bigola2823",
          healthStatus: GameAccountHealth.ACTIVE,
          lastKnownBalance: (10n * ONE_TRILLION).toString(),
          reservedForOrders: "0",
          lastSyncedAt: new Date(),
          encryptedSessionBundle: treasurySession,
        },
      });

      let sendOutcome: "SUCCEEDED" | "AMBIGUOUS" = "SUCCEEDED";
      const mockAdapter = {
        resolveTargetIdAsync: async (username: string) => ({
          id: `uid_${username}`,
          username,
          name: username,
        }),
        sendCurrencyChunk: async () =>
          sendOutcome === "SUCCEEDED"
            ? { outcome: "SUCCEEDED", status: 200 }
            : { outcome: "UNCERTAIN", status: 504, message: "Gateway timeout" },
      } as unknown as LagosLifeAdapter;

      const invSvc = new InventoryService(prisma, {
        encryptionKeyHex: env.ENCRYPTION_KEY_HEX,
        lagosLifeAdapter: mockAdapter,
      });

      // 1. Create dynamic reserve slot
      const created = await invSvc.createReserveAccount({
        actorUserId: owner.id,
        slotCode: testSlotCode,
        lagoslifeUsername: `p2res_${runId.toLowerCase()}`,
        targetReserveAmount: 70n * ONE_TRILLION,
        reason: "P2 dynamic slot test",
      });
      createdReserveId = created.id;
      assert.equal(created.slotCode, testSlotCode);
      assert.equal(created.accountRole, GameAccountRole.RESERVE);

      // 2. Refill blocked when DISBURSEMENT_ENABLED=false
      await assert.rejects(
        () =>
          invSvc.executeTreasuryToReserveStep({
            actorUserId: owner.id,
            targetSlotCode: testSlotCode,
            remainingAmount: 200_000_000_000n,
            refillId: `r1_${runId}`,
            stepIndex: 1,
            reason: "Disabled guard test",
            disbursementEnabled: false,
          }),
        (err: unknown) => err instanceof InventoryError && err.code === "DISBURSEMENT_DISABLED"
      );

      // 3. Execute 200B refill -> sends 100B chunk #1, returns remaining 100B + 30.5s delay
      const step1 = await invSvc.executeTreasuryToReserveStep({
        actorUserId: owner.id,
        targetSlotCode: testSlotCode,
        remainingAmount: 200_000_000_000n,
        refillId: `r2_${runId}`,
        stepIndex: 1,
        reason: "P2 chunked refill",
        disbursementEnabled: true,
      });
      assert.equal(step1.status, "SUCCEEDED");
      assert.equal(step1.chunkAmount, "100000000000");
      assert.equal(step1.remainingAmount, "100000000000");
      assert.equal(step1.nextDelayMs, 30_500);

      const ledgerRows = await prisma.inventoryLedger.findMany({
        where: { gameAccountId: created.id, entryType: InventoryEntryType.TREASURY_TO_RESERVE },
      });
      assert.equal(ledgerRows.length, 1);
      assert.equal(ledgerRows[0].deltaAmount.toFixed(0), "100000000000");

      // 4. Ambiguous transfer stops immediately with AMBIGUOUS_MANUAL_REVIEW (never retries)
      sendOutcome = "AMBIGUOUS";
      const step2 = await invSvc.executeTreasuryToReserveStep({
        actorUserId: owner.id,
        targetSlotCode: testSlotCode,
        remainingAmount: 100_000_000_000n,
        refillId: `r2_${runId}`,
        stepIndex: 2,
        reason: "P2 ambiguous test",
        disbursementEnabled: true,
      });
      assert.equal(step2.status, "AMBIGUOUS_MANUAL_REVIEW");
      assert.equal(step2.nextDelayMs, null);
    } finally {
      if (createdReserveId) {
        await prisma.inventoryLedger.deleteMany({ where: { gameAccountId: createdReserveId } }).catch(() => undefined);
        await prisma.gameAccount.delete({ where: { id: createdReserveId } }).catch(() => undefined);
      }
      if (origTreasury) {
        await prisma.inventoryLedger
          .deleteMany({
            where: {
              gameAccountId: origTreasury.id,
              entryType: InventoryEntryType.TREASURY_TO_RESERVE,
              createdById: createdOwnerId ?? undefined,
            },
          })
          .catch(() => undefined);
        await prisma.gameAccount
          .update({
            where: { id: origTreasury.id },
            data: {
              lastKnownBalance: origTreasury.lastKnownBalance,
              reservedForOrders: origTreasury.reservedForOrders,
              lastSyncedAt: origTreasury.lastSyncedAt,
              healthStatus: origTreasury.healthStatus,
              encryptedSessionBundle: origTreasury.encryptedSessionBundle,
            },
          })
          .catch(() => undefined);
      }
      if (createdOwnerId) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: createdOwnerId } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: createdOwnerId } }).catch(() => undefined);
      }
      await prisma.$disconnect();
    }
  });
});
