import {
  GameAccountHealth,
  InventoryDiscrepancyStatus,
  InventoryEntryType,
  NotificationType,
  Prisma,
  PrismaClient,
  UserRole,
} from "@prisma/client";
import {
  DEFAULT_INVENTORY_MAX_AGE_MINUTES,
  ONE_TRILLION,
  isInventoryStale,
  normalizeLagoslifeUsername,
} from "@bigola/shared";
import {
  LagosLifeAdapter,
  LagosLifeError,
  decodeEncryptedSessionBundle,
  encodeEncryptedSessionBundle,
  getSafeSessionMetadata,
  type StoredSessionBundle,
} from "./lagoslife.js";

export class InventoryError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "InventoryError";
  }
}

export async function getInventoryMaxAgeMinutes(
  db: Pick<PrismaClient, "platformSetting"> | Prisma.TransactionClient
): Promise<number> {
  const setting = await db.platformSetting.findUnique({
    where: { key: "inventory_freshness_policy" },
  });
  const val = setting?.value as { maxAgeMinutes?: unknown } | undefined;
  const parsed = Number(val?.maxAgeMinutes);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return DEFAULT_INVENTORY_MAX_AGE_MINUTES;
}

export async function getManualFulfilmentDebitsSinceSync(
  db: Pick<PrismaClient, "inventoryLedger"> | Prisma.TransactionClient,
  gameAccountId: string,
  lastSyncedAt: Date | null
): Promise<bigint> {
  const entries = await db.inventoryLedger.findMany({
    where: {
      gameAccountId,
      entryType: InventoryEntryType.MANUAL_FULFILMENT_DEBIT,
      ...(lastSyncedAt ? { createdAt: { gt: lastSyncedAt } } : {}),
    },
    select: { deltaAmount: true },
  });
  let totalDebits = 0n;
  for (const entry of entries) {
    const delta = BigInt(entry.deltaAmount.toFixed(0));
    if (delta < 0n) {
      totalDebits += -delta;
    }
  }
  return totalDebits;
}

export class InventoryService {
  private readonly encryptionKeyHex: string;
  private readonly lagosLifeAdapter: LagosLifeAdapter;

  constructor(
    private readonly prisma: PrismaClient,
    opts?: { encryptionKeyHex?: string; lagosLifeAdapter?: LagosLifeAdapter }
  ) {
    this.encryptionKeyHex =
      opts?.encryptionKeyHex ??
      process.env.ENCRYPTION_KEY_HEX ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    this.lagosLifeAdapter = opts?.lagosLifeAdapter ?? new LagosLifeAdapter();
  }

  getLagosLifeAdapter(): LagosLifeAdapter {
    return this.lagosLifeAdapter;
  }

  async getInventoryOverview(now: Date = new Date()) {
    const [accounts, maxAgeMinutes, recentLedger, openDiscrepanciesCount] = await Promise.all([
      this.prisma.gameAccount.findMany({ orderBy: { slotCode: "asc" } }),
      getInventoryMaxAgeMinutes(this.prisma),
      this.prisma.inventoryLedger.findMany({
        orderBy: { createdAt: "desc" },
        take: 25,
        include: {
          gameAccount: { select: { slotCode: true } },
        },
      }),
      this.prisma.inventoryDiscrepancy.count({
        where: { status: InventoryDiscrepancyStatus.OPEN },
      }),
    ]);

    const debitsPerAccount = await Promise.all(
      accounts.map((acc) =>
        getManualFulfilmentDebitsSinceSync(this.prisma, acc.id, acc.lastSyncedAt)
      )
    );

    let totalObservedBalance = 0n;
    let totalManualDebitsSinceSync = 0n;
    let totalExpectedBalance = 0n;
    let totalReservedForOrders = 0n;
    let totalNetAvailableBalance = 0n;
    let totalReservableAvailable = 0n;
    let totalLogicalAllocation = 0n;

    const slots = accounts.map((acc, idx) => {
      const observed = BigInt(acc.lastKnownBalance.toFixed(0));
      const manualDebitsSinceSync = debitsPerAccount[idx] ?? 0n;
      const expectedBalance = observed > manualDebitsSinceSync ? observed - manualDebitsSinceSync : 0n;
      const reserved = BigInt(acc.reservedForOrders.toFixed(0));
      const targetReserve = BigInt(acc.targetReserveAmount.toFixed(0));
      const logicalAllocation = BigInt(acc.logicalAllocationAmount.toFixed(0));
      const stale = isInventoryStale(acc.lastSyncedAt, maxAgeMinutes, now);
      const effectiveHealthStatus =
        acc.healthStatus === GameAccountHealth.SESSION_EXPIRED ||
        acc.healthStatus === GameAccountHealth.DISABLED ||
        acc.healthStatus === GameAccountHealth.UNCONFIGURED
          ? acc.healthStatus
          : stale
            ? GameAccountHealth.STALE
            : acc.healthStatus;

      const netAvailableBalance = expectedBalance > reserved ? expectedBalance - reserved : 0n;
      const reservableAvailable =
        !stale && acc.healthStatus === GameAccountHealth.ACTIVE ? netAvailableBalance : 0n;

      const sessionMeta = getSafeSessionMetadata(acc.encryptedSessionBundle, this.encryptionKeyHex);
      const connectionStatus =
        acc.healthStatus === GameAccountHealth.SESSION_EXPIRED
          ? "SESSION_EXPIRED"
          : sessionMeta.connected
            ? "CONNECTED"
            : "DISCONNECTED";

      totalObservedBalance += observed;
      totalManualDebitsSinceSync += manualDebitsSinceSync;
      totalExpectedBalance += expectedBalance;
      totalReservedForOrders += reserved;
      totalNetAvailableBalance += netAvailableBalance;
      totalReservableAvailable += reservableAvailable;
      totalLogicalAllocation += logicalAllocation;

      return {
        id: acc.id,
        slotCode: acc.slotCode,
        lagoslifeUsername: acc.lagoslifeUsername,
        accountRole: acc.accountRole,
        observedBalance: observed.toString(),
        manualFulfilmentDebitsSinceSync: manualDebitsSinceSync.toString(),
        expectedBalance: expectedBalance.toString(),
        reservedForOrders: reserved.toString(),
        netAvailableBalance: netAvailableBalance.toString(),
        reservableAvailable: reservableAvailable.toString(),
        targetReserveAmount: targetReserve.toString(),
        logicalAllocationAmount: logicalAllocation.toString(),
        healthStatus: acc.healthStatus,
        effectiveHealthStatus,
        isStale: stale,
        lastSyncedAt: acc.lastSyncedAt?.toISOString() ?? null,
        sessionConnected: sessionMeta.connected && acc.healthStatus !== GameAccountHealth.SESSION_EXPIRED,
        connectionStatus,
        sessionIdentity: sessionMeta.connected
          ? {
              uid: sessionMeta.uid,
              username: sessionMeta.username,
              simName: sessionMeta.simName,
              connectedAt: sessionMeta.connectedAt,
              verifiedAt: sessionMeta.verifiedAt,
            }
          : null,
        eligibleForFulfilment:
          !stale &&
          acc.healthStatus === GameAccountHealth.ACTIVE &&
          Boolean(acc.lagoslifeUsername) &&
          netAvailableBalance > 0n,
      };
    });

    return {
      maxAgeMinutes,
      openDiscrepanciesCount,
      totals: {
        observedBalance: totalObservedBalance.toString(),
        manualFulfilmentDebitsSinceSync: totalManualDebitsSinceSync.toString(),
        expectedBalance: totalExpectedBalance.toString(),
        reservedForOrders: totalReservedForOrders.toString(),
        netAvailableBalance: totalNetAvailableBalance.toString(),
        reservableAvailable: totalReservableAvailable.toString(),
        logicalAllocationAmount: totalLogicalAllocation.toString(),
      },
      slots,
      recentLedger: recentLedger.map((entry) => ({
        id: entry.id,
        slotCode: entry.gameAccount.slotCode,
        orderId: entry.orderId,
        entryType: entry.entryType,
        deltaAmount: entry.deltaAmount.toFixed(0),
        balanceAfter: entry.balanceAfter.toFixed(0),
        notes: entry.notes,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  async syncAccountBalance(input: {
    actorUserId: string;
    slotCode: string;
    observedBalance: bigint;
    healthStatus?: GameAccountHealth;
    lagoslifeUsername?: string;
    reason: string;
    ipAddress?: string;
  }) {
    if (input.observedBalance < 0n) {
      throw new InventoryError(400, "INVALID_BALANCE", "Observed balance cannot be negative.");
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          slot_code: string;
          last_known_balance: string;
          reserved_for_orders: string;
          health_status: GameAccountHealth;
          lagoslife_username: string | null;
          last_synced_at: Date | null;
        }>
      >`
        SELECT id, slot_code, last_known_balance::text, reserved_for_orders::text, health_status, lagoslife_username, last_synced_at
        FROM game_accounts
        WHERE slot_code = ${input.slotCode}
        FOR UPDATE
      `;

      const row = locked[0];
      if (!row) {
        throw new InventoryError(404, "SLOT_NOT_FOUND", `Game account slot ${input.slotCode} not found.`);
      }

      const prevBalance = BigInt(row.last_known_balance.split(".")[0] ?? "0");
      const reserved = BigInt(row.reserved_for_orders.split(".")[0] ?? "0");
      const manualDebitsSinceSync = await getManualFulfilmentDebitsSinceSync(
        tx,
        row.id,
        row.last_synced_at
      );
      const expectedBalance =
        prevBalance > manualDebitsSinceSync ? prevBalance - manualDebitsSinceSync : 0n;

      if (input.observedBalance < reserved) {
        throw new InventoryError(
          409,
          "BALANCE_BELOW_RESERVED",
          `Observed balance (${input.observedBalance}) cannot be lower than active reservations (${reserved}).`
        );
      }

      const nextHealth =
        input.healthStatus ??
        (row.health_status === GameAccountHealth.UNCONFIGURED ||
        row.health_status === GameAccountHealth.STALE
          ? GameAccountHealth.ACTIVE
          : row.health_status);

      const updated = await tx.gameAccount.update({
        where: { id: row.id },
        data: {
          lastKnownBalance: input.observedBalance.toString(),
          healthStatus: nextHealth,
          lastSyncedAt: now,
          ...(input.lagoslifeUsername !== undefined
            ? { lagoslifeUsername: input.lagoslifeUsername }
            : {}),
        },
      });

      const delta = input.observedBalance - prevBalance;
      const syncLedger = await tx.inventoryLedger.create({
        data: {
          gameAccountId: row.id,
          entryType: InventoryEntryType.TREASURY_SYNC,
          deltaAmount: delta.toString(),
          balanceAfter: input.observedBalance.toString(),
          createdById: input.actorUserId,
          notes: `MANUAL_SYNC: ${input.reason}`,
        },
      });

      let discrepancyCreated: { id: string; deltaAmount: string } | null = null;
      if (row.last_synced_at !== null && input.observedBalance !== expectedBalance) {
        const discrepancyDelta = input.observedBalance - expectedBalance;
        const disc = await tx.inventoryDiscrepancy.create({
          data: {
            gameAccountId: row.id,
            expectedBalance: expectedBalance.toString(),
            observedBalance: input.observedBalance.toString(),
            deltaAmount: discrepancyDelta.toString(),
            status: InventoryDiscrepancyStatus.OPEN,
            syncLedgerId: syncLedger.id,
          },
        });
        discrepancyCreated = {
          id: disc.id,
          deltaAmount: discrepancyDelta.toString(),
        };

        const owners = await tx.user.findMany({
          where: { role: UserRole.OWNER, isActive: true },
          select: { id: true },
        });
        if (owners.length > 0) {
          await tx.notification.createMany({
            data: owners.map((o) => ({
              recipientUserId: o.id,
              type: NotificationType.INVENTORY_DISCREPANCY,
              title: `Inventory discrepancy on ${row.slot_code}`,
              message: `Expected ${expectedBalance.toString()} but observed ${input.observedBalance.toString()} (delta ${discrepancyDelta.toString()}).`,
            })),
          });
        }
      }

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "INVENTORY_MANUAL_SYNC",
          targetEntity: "game_accounts",
          targetId: row.id,
          beforeState: {
            slotCode: row.slot_code,
            observedBalance: prevBalance.toString(),
            healthStatus: row.health_status,
          },
          afterState: {
            slotCode: row.slot_code,
            observedBalance: input.observedBalance.toString(),
            healthStatus: nextHealth,
            lastSyncedAt: now.toISOString(),
          },
          reason: input.reason,
          ipAddress: input.ipAddress,
        },
      });

      return { account: updated, discrepancy: discrepancyCreated };
    }, { timeout: 20000, maxWait: 10000 });
  }

  /**
   * Logical reserve allocation only (Amendment 4).
   * Never mutates observed lastKnownBalance and never executes real LagosLife transfers.
   */
  async allocateLogicalReserve(input: {
    actorUserId: string;
    targetSlotCode: string;
    logicalAllocationAmount: bigint;
    reason: string;
    ipAddress?: string;
  }) {
    if (input.logicalAllocationAmount < 0n) {
      throw new InventoryError(400, "INVALID_ALLOCATION", "Logical allocation cannot be negative.");
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          slot_code: string;
          logical_allocation_amount: string;
          last_known_balance: string;
        }>
      >`
        SELECT id, slot_code, logical_allocation_amount::text, last_known_balance::text
        FROM game_accounts
        WHERE slot_code = ${input.targetSlotCode}
        FOR UPDATE
      `;

      const row = locked[0];
      if (!row) {
        throw new InventoryError(404, "SLOT_NOT_FOUND", `Game account slot ${input.targetSlotCode} not found.`);
      }

      const prevLogical = BigInt(row.logical_allocation_amount.split(".")[0] ?? "0");
      const observed = BigInt(row.last_known_balance.split(".")[0] ?? "0");

      const updated = await tx.gameAccount.update({
        where: { id: row.id },
        data: {
          logicalAllocationAmount: input.logicalAllocationAmount.toString(),
        },
      });

      await tx.inventoryLedger.create({
        data: {
          gameAccountId: row.id,
          entryType: InventoryEntryType.TREASURY_TO_RESERVE,
          deltaAmount: "0",
          balanceAfter: observed.toString(),
          createdById: input.actorUserId,
          notes: `LOGICAL_ALLOCATION_ONLY (no LagosLife transfer; observed balance unchanged): ${prevLogical.toString()} -> ${input.logicalAllocationAmount.toString()}. ${input.reason}`,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "INVENTORY_LOGICAL_ALLOCATION",
          targetEntity: "game_accounts",
          targetId: row.id,
          beforeState: {
            slotCode: row.slot_code,
            logicalAllocationAmount: prevLogical.toString(),
            observedBalance: observed.toString(),
          },
          afterState: {
            slotCode: row.slot_code,
            logicalAllocationAmount: input.logicalAllocationAmount.toString(),
            observedBalance: observed.toString(),
          },
          reason: input.reason,
          ipAddress: input.ipAddress,
        },
      });

      return updated;
    }, { timeout: 20000, maxWait: 10000 });
  }

  async listDiscrepancies(status?: InventoryDiscrepancyStatus) {
    const items = await this.prisma.inventoryDiscrepancy.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        gameAccount: { select: { slotCode: true, accountRole: true } },
        acknowledgedBy: { select: { id: true, email: true } },
      },
    });
    return items.map((d) => ({
      id: d.id,
      gameAccountId: d.gameAccountId,
      slotCode: d.gameAccount.slotCode,
      accountRole: d.gameAccount.accountRole,
      expectedBalance: d.expectedBalance.toFixed(0),
      observedBalance: d.observedBalance.toFixed(0),
      deltaAmount: d.deltaAmount.toFixed(0),
      status: d.status,
      syncLedgerId: d.syncLedgerId,
      acknowledgedBy: d.acknowledgedBy,
      resolutionNotes: d.resolutionNotes,
      createdAt: d.createdAt.toISOString(),
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
    }));
  }

  async resolveDiscrepancy(input: {
    discrepancyId: string;
    actorUserId: string;
    status: "ACKNOWLEDGED" | "RESOLVED";
    resolutionNotes: string;
    ipAddress?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.inventoryDiscrepancy.findUnique({
        where: { id: input.discrepancyId },
      });
      if (!existing) {
        throw new InventoryError(404, "DISCREPANCY_NOT_FOUND", "Inventory discrepancy not found.");
      }

      const now = new Date();
      const updated = await tx.inventoryDiscrepancy.update({
        where: { id: existing.id },
        data: {
          status:
            input.status === "RESOLVED"
              ? InventoryDiscrepancyStatus.RESOLVED
              : InventoryDiscrepancyStatus.ACKNOWLEDGED,
          acknowledgedByUserId: input.actorUserId,
          resolutionNotes: input.resolutionNotes,
          resolvedAt: input.status === "RESOLVED" ? now : existing.resolvedAt,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "INVENTORY_DISCREPANCY_UPDATED",
          targetEntity: "inventory_discrepancies",
          targetId: existing.id,
          beforeState: { status: existing.status },
          afterState: { status: updated.status, resolutionNotes: input.resolutionNotes },
          reason: input.resolutionNotes,
          ipAddress: input.ipAddress,
        },
      });

      return updated;
    }, { timeout: 20000, maxWait: 10000 });
  }

  async updateReserveAccount(input: {
    accountId: string;
    actorUserId: string;
    targetReserveAmount?: bigint;
    lagoslifeUsername?: string | null;
    healthStatus?: GameAccountHealth;
    reason: string;
    ipAddress?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.gameAccount.findUnique({ where: { id: input.accountId } });
      if (!existing) {
        throw new InventoryError(404, "ACCOUNT_NOT_FOUND", "Game account not found.");
      }

      const updated = await tx.gameAccount.update({
        where: { id: existing.id },
        data: {
          ...(input.targetReserveAmount !== undefined
            ? { targetReserveAmount: input.targetReserveAmount.toString() }
            : {}),
          ...(input.lagoslifeUsername !== undefined
            ? { lagoslifeUsername: input.lagoslifeUsername }
            : {}),
          ...(input.healthStatus !== undefined ? { healthStatus: input.healthStatus } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "INVENTORY_ACCOUNT_UPDATED",
          targetEntity: "game_accounts",
          targetId: existing.id,
          beforeState: {
            targetReserveAmount: existing.targetReserveAmount.toFixed(0),
            lagoslifeUsername: existing.lagoslifeUsername,
            healthStatus: existing.healthStatus,
          },
          afterState: {
            targetReserveAmount: updated.targetReserveAmount.toFixed(0),
            lagoslifeUsername: updated.lagoslifeUsername,
            healthStatus: updated.healthStatus,
          },
          reason: input.reason,
          ipAddress: input.ipAddress,
        },
      });

      return updated;
    }, { timeout: 20000, maxWait: 10000 });
  }

  async checkInventoryAlerts(opts?: { notifyOwners?: boolean }) {
    const [overview, thresholdSetting] = await Promise.all([
      this.getInventoryOverview(),
      this.prisma.platformSetting.findUnique({ where: { key: "low_stock_threshold" } }),
    ]);

    const rawThreshold = (thresholdSetting?.value as { minAvailableTrillions?: unknown } | undefined)
      ?.minAvailableTrillions;
    const minTrillions =
      Number.isFinite(Number(rawThreshold)) && Number(rawThreshold) >= 0
        ? BigInt(Math.floor(Number(rawThreshold)))
        : 20n;
    const lowStockThreshold = minTrillions * ONE_TRILLION;

    const alerts: Array<{
      slotCode: string;
      type: "STALE" | "LOW_STOCK";
      message: string;
    }> = [];

    for (const slot of overview.slots) {
      if (slot.isStale) {
        alerts.push({
          slotCode: slot.slotCode,
          type: "STALE",
          message: `${slot.slotCode} inventory sync is stale (max age ${overview.maxAgeMinutes}m).`,
        });
      }
      const netAvail = BigInt(slot.netAvailableBalance);
      if (slot.accountRole === "RESERVE" && netAvail < lowStockThreshold) {
        alerts.push({
          slotCode: slot.slotCode,
          type: "LOW_STOCK",
          message: `${slot.slotCode} net available balance is below ${minTrillions.toString()}T threshold.`,
        });
      }
    }

    if (opts?.notifyOwners && alerts.length > 0) {
      const owners = await this.prisma.user.findMany({
        where: { role: UserRole.OWNER, isActive: true },
        select: { id: true },
      });
      if (owners.length > 0) {
        await this.prisma.notification.createMany({
          data: alerts.flatMap((a) =>
            owners.map((o) => ({
              recipientUserId: o.id,
              type:
                a.type === "STALE"
                  ? NotificationType.INVENTORY_STALE
                  : NotificationType.INVENTORY_LOW_STOCK,
              title: `${a.type === "STALE" ? "Stale Inventory" : "Low Stock Alert"}: ${a.slotCode}`,
              message: a.message,
            }))
          ),
        });
      }
    }

    return {
      lowStockThresholdTrillions: minTrillions.toString(),
      alerts,
    };
  }

  private assertSlotIdentityMatch(
    slot: { slotCode: string; lagoslifeUsername: string | null },
    authenticatedUsername: string
  ) {
    const cleanAuth = normalizeLagoslifeUsername(authenticatedUsername);
    if (!cleanAuth) {
      throw new InventoryError(
        401,
        "INVALID_LAGOSLIFE_IDENTITY",
        "LagosLife did not return a valid username for this session."
      );
    }

    if (slot.lagoslifeUsername) {
      const configuredClean = normalizeLagoslifeUsername(slot.lagoslifeUsername);
      if (configuredClean !== cleanAuth) {
        throw new InventoryError(
          409,
          "SLOT_IDENTITY_MISMATCH",
          `Slot ${slot.slotCode} is configured for LagosLife account @${configuredClean}, but the authenticated session belongs to @${cleanAuth}.`
        );
      }
    }
  }

  private async persistValidatedSlotSession(input: {
    actorUserId: string;
    slotCode: string;
    cookie: string;
    uid: string;
    username: string;
    simName: string | null;
    observedBalance: bigint;
    authMethod: "CREDENTIALS" | "CREDENTIALS_2FA" | "COOKIE_IMPORT";
    ipAddress?: string;
  }) {
    const cleanUsername = normalizeLagoslifeUsername(input.username);
    const slot = await this.prisma.gameAccount.findUnique({
      where: { slotCode: input.slotCode },
    });
    if (!slot) {
      throw new InventoryError(404, "SLOT_NOT_FOUND", `Game account slot ${input.slotCode} not found.`);
    }

    this.assertSlotIdentityMatch(slot, cleanUsername);

    const conflictingSlot = await this.prisma.gameAccount.findFirst({
      where: {
        lagoslifeUsername: { equals: cleanUsername, mode: "insensitive" },
        NOT: { id: slot.id },
      },
      select: { slotCode: true },
    });
    if (conflictingSlot) {
      throw new InventoryError(
        409,
        "DUPLICATE_LAGOSLIFE_USERNAME",
        `LagosLife account @${cleanUsername} is already assigned to slot ${conflictingSlot.slotCode}.`
      );
    }

    const nowIso = new Date().toISOString();
    const bundle: StoredSessionBundle = {
      cookie: input.cookie,
      uid: input.uid,
      username: cleanUsername,
      simName: input.simName,
      connectedAt: nowIso,
      verifiedAt: nowIso,
    };
    const encryptedSessionBundle = encodeEncryptedSessionBundle(bundle, this.encryptionKeyHex);

    await this.prisma.gameAccount.update({
      where: { id: slot.id },
      data: {
        encryptedSessionBundle,
        lagoslifeUsername: cleanUsername,
      },
    });

    const syncResult = await this.syncAccountBalance({
      actorUserId: input.actorUserId,
      slotCode: slot.slotCode,
      observedBalance: input.observedBalance,
      healthStatus: GameAccountHealth.ACTIVE,
      lagoslifeUsername: cleanUsername,
      reason: `LagosLife session connected via ${input.authMethod} (@${cleanUsername})`,
      ipAddress: input.ipAddress,
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        actionType: "LAGOSLIFE_ACCOUNT_CONNECTED",
        targetEntity: "game_accounts",
        targetId: slot.id,
        beforeState: {
          slotCode: slot.slotCode,
          lagoslifeUsername: slot.lagoslifeUsername,
          healthStatus: slot.healthStatus,
          hadSession: Boolean(slot.encryptedSessionBundle),
        },
        afterState: {
          slotCode: slot.slotCode,
          lagoslifeUsername: cleanUsername,
          uid: input.uid || null,
          simName: input.simName,
          authMethod: input.authMethod,
          observedBalance: input.observedBalance.toString(),
          healthStatus: GameAccountHealth.ACTIVE,
          sessionConnected: true,
        },
        reason: `Connected LagosLife account @${cleanUsername} to ${slot.slotCode} via ${input.authMethod}`,
        ipAddress: input.ipAddress,
      },
    });

    return {
      status: "CONNECTED" as const,
      slotCode: slot.slotCode,
      lagoslifeUsername: cleanUsername,
      sessionIdentity: {
        uid: input.uid || null,
        username: cleanUsername,
        simName: input.simName,
        connectedAt: nowIso,
        verifiedAt: nowIso,
      },
      observedBalance: syncResult.account.lastKnownBalance.toFixed(0),
      reservedForOrders: syncResult.account.reservedForOrders.toFixed(0),
      healthStatus: syncResult.account.healthStatus,
      lastSyncedAt: syncResult.account.lastSyncedAt?.toISOString() ?? nowIso,
      discrepancy: syncResult.discrepancy,
    };
  }

  async connectSlotWithCredentials(input: {
    actorUserId: string;
    slotCode: string;
    username: string;
    password: string;
    ipAddress?: string;
  }) {
    const slot = await this.prisma.gameAccount.findUnique({
      where: { slotCode: input.slotCode },
    });
    if (!slot) {
      throw new InventoryError(404, "SLOT_NOT_FOUND", `Game account slot ${input.slotCode} not found.`);
    }

    const cleanUsername = normalizeLagoslifeUsername(input.username);
    this.assertSlotIdentityMatch(slot, cleanUsername);

    const conflictingSlot = await this.prisma.gameAccount.findFirst({
      where: {
        lagoslifeUsername: { equals: cleanUsername, mode: "insensitive" },
        NOT: { id: slot.id },
      },
      select: { slotCode: true },
    });
    if (conflictingSlot) {
      throw new InventoryError(
        409,
        "DUPLICATE_LAGOSLIFE_USERNAME",
        `LagosLife account @${cleanUsername} is already assigned to slot ${conflictingSlot.slotCode}.`
      );
    }

    try {
      const outcome = await this.lagosLifeAdapter.loginWithCredentials({
        slotCode: slot.slotCode,
        username: cleanUsername,
        password: input.password,
      });

      if (outcome.status === "TWO_FACTOR_REQUIRED") {
        await this.prisma.auditLog.create({
          data: {
            actorUserId: input.actorUserId,
            actionType: "LAGOSLIFE_2FA_CHALLENGE_ISSUED",
            targetEntity: "game_accounts",
            targetId: slot.id,
            afterState: {
              slotCode: slot.slotCode,
              lagoslifeUsername: cleanUsername,
              method: outcome.method,
            },
            reason: `LagosLife 2FA challenge required for ${slot.slotCode} (@${cleanUsername})`,
            ipAddress: input.ipAddress,
          },
        });

        return {
          status: "TWO_FACTOR_REQUIRED" as const,
          slotCode: slot.slotCode,
          challenge: outcome.challenge,
          method: outcome.method,
          to: outcome.to,
          message: outcome.message,
        };
      }

      this.assertSlotIdentityMatch(slot, outcome.identity.username);

      return await this.persistValidatedSlotSession({
        actorUserId: input.actorUserId,
        slotCode: slot.slotCode,
        cookie: outcome.cookie,
        uid: outcome.identity.uid,
        username: outcome.identity.username,
        simName: outcome.identity.name,
        observedBalance: outcome.accountData.money ?? 0n,
        authMethod: "CREDENTIALS",
        ipAddress: input.ipAddress,
      });
    } catch (err) {
      if (err instanceof LagosLifeError) {
        throw new InventoryError(err.statusCode, err.code, err.message);
      }
      throw err;
    }
  }

  async completeSlotLoginTwoFactor(input: {
    actorUserId: string;
    slotCode: string;
    challenge: string;
    code: string;
    ipAddress?: string;
  }) {
    const slot = await this.prisma.gameAccount.findUnique({
      where: { slotCode: input.slotCode },
    });
    if (!slot) {
      throw new InventoryError(404, "SLOT_NOT_FOUND", `Game account slot ${input.slotCode} not found.`);
    }

    try {
      const completed = await this.lagosLifeAdapter.completeLoginTwoFactor({
        slotCode: slot.slotCode,
        challenge: input.challenge,
        code: input.code,
      });

      this.assertSlotIdentityMatch(slot, completed.identity.username);

      return await this.persistValidatedSlotSession({
        actorUserId: input.actorUserId,
        slotCode: slot.slotCode,
        cookie: completed.cookie,
        uid: completed.identity.uid,
        username: completed.identity.username,
        simName: completed.identity.name,
        observedBalance: completed.accountData.money ?? 0n,
        authMethod: "CREDENTIALS_2FA",
        ipAddress: input.ipAddress,
      });
    } catch (err) {
      if (err instanceof LagosLifeError) {
        throw new InventoryError(err.statusCode, err.code, err.message);
      }
      throw err;
    }
  }

  async resendSlotLoginTwoFactor(input: {
    slotCode: string;
    challenge: string;
  }) {
    const slot = await this.prisma.gameAccount.findUnique({
      where: { slotCode: input.slotCode },
    });
    if (!slot) {
      throw new InventoryError(404, "SLOT_NOT_FOUND", `Game account slot ${input.slotCode} not found.`);
    }

    try {
      return await this.lagosLifeAdapter.resendLoginTwoFactor(input.challenge);
    } catch (err) {
      if (err instanceof LagosLifeError) {
        throw new InventoryError(err.statusCode, err.code, err.message);
      }
      throw err;
    }
  }

  async importSlotCookie(input: {
    actorUserId: string;
    slotCode: string;
    cookie: string;
    lagoslifeUsername?: string;
    ipAddress?: string;
  }) {
    const slot = await this.prisma.gameAccount.findUnique({
      where: { slotCode: input.slotCode },
    });
    if (!slot) {
      throw new InventoryError(404, "SLOT_NOT_FOUND", `Game account slot ${input.slotCode} not found.`);
    }

    if (input.lagoslifeUsername) {
      this.assertSlotIdentityMatch(slot, input.lagoslifeUsername);
    }

    try {
      const validated = await this.lagosLifeAdapter.validateImportedCookie(input.cookie);
      if (
        input.lagoslifeUsername &&
        normalizeLagoslifeUsername(input.lagoslifeUsername) !== validated.identity.username
      ) {
        throw new InventoryError(
          409,
          "SLOT_IDENTITY_MISMATCH",
          `Provided username @${normalizeLagoslifeUsername(input.lagoslifeUsername)} does not match cookie owner @${validated.identity.username}.`
        );
      }

      this.assertSlotIdentityMatch(slot, validated.identity.username);

      return await this.persistValidatedSlotSession({
        actorUserId: input.actorUserId,
        slotCode: slot.slotCode,
        cookie: validated.cookie,
        uid: validated.identity.uid,
        username: validated.identity.username,
        simName: validated.identity.name,
        observedBalance: validated.accountData.money ?? 0n,
        authMethod: "COOKIE_IMPORT",
        ipAddress: input.ipAddress,
      });
    } catch (err) {
      if (err instanceof LagosLifeError) {
        throw new InventoryError(err.statusCode, err.code, err.message);
      }
      throw err;
    }
  }

  async verifySlotSession(input: {
    actorUserId: string;
    slotCode: string;
    ipAddress?: string;
  }) {
    const slot = await this.prisma.gameAccount.findUnique({
      where: { slotCode: input.slotCode },
    });
    if (!slot) {
      throw new InventoryError(404, "SLOT_NOT_FOUND", `Game account slot ${input.slotCode} not found.`);
    }

    const decoded = decodeEncryptedSessionBundle(slot.encryptedSessionBundle, this.encryptionKeyHex);
    if (!decoded) {
      return {
        slotCode: slot.slotCode,
        valid: false,
        connectionStatus: "DISCONNECTED" as const,
        healthStatus: slot.healthStatus,
        error: "No LagosLife session is currently configured for this slot.",
      };
    }

    try {
      const identity = await this.lagosLifeAdapter.verifySessionIdentity(decoded.cookie);
      this.assertSlotIdentityMatch(slot, identity.username);

      const nowIso = new Date().toISOString();
      const updatedBundle: StoredSessionBundle = {
        ...decoded,
        uid: identity.uid || decoded.uid,
        username: identity.username,
        simName: identity.name ?? decoded.simName,
        verifiedAt: nowIso,
      };
      const encryptedSessionBundle = encodeEncryptedSessionBundle(
        updatedBundle,
        this.encryptionKeyHex
      );

      await this.prisma.gameAccount.update({
        where: { id: slot.id },
        data: { encryptedSessionBundle },
      });

      return {
        slotCode: slot.slotCode,
        valid: true,
        connectionStatus: "CONNECTED" as const,
        healthStatus: slot.healthStatus,
        sessionIdentity: {
          uid: updatedBundle.uid || null,
          username: updatedBundle.username,
          simName: updatedBundle.simName,
          connectedAt: updatedBundle.connectedAt,
          verifiedAt: updatedBundle.verifiedAt,
        },
      };
    } catch (err) {
      if (err instanceof LagosLifeError && err.statusCode === 401) {
        const updated = await this.prisma.gameAccount.update({
          where: { id: slot.id },
          data: { healthStatus: GameAccountHealth.SESSION_EXPIRED },
        });
        await this.prisma.auditLog.create({
          data: {
            actorUserId: input.actorUserId,
            actionType: "LAGOSLIFE_SESSION_EXPIRED_DETECTED",
            targetEntity: "game_accounts",
            targetId: slot.id,
            beforeState: { slotCode: slot.slotCode, healthStatus: slot.healthStatus },
            afterState: { slotCode: slot.slotCode, healthStatus: updated.healthStatus },
            reason: "LagosLife /api/auth/me returned 401 Unauthorized",
            ipAddress: input.ipAddress,
          },
        });
        return {
          slotCode: slot.slotCode,
          valid: false,
          connectionStatus: "SESSION_EXPIRED" as const,
          healthStatus: updated.healthStatus,
          error: err.message,
        };
      }
      if (err instanceof LagosLifeError) {
        throw new InventoryError(err.statusCode, err.code, err.message);
      }
      throw err;
    }
  }

  async syncLiveSlotBalance(input: {
    actorUserId: string;
    slotCode: string;
    ipAddress?: string;
  }) {
    const slot = await this.prisma.gameAccount.findUnique({
      where: { slotCode: input.slotCode },
    });
    if (!slot) {
      throw new InventoryError(404, "SLOT_NOT_FOUND", `Game account slot ${input.slotCode} not found.`);
    }

    const decoded = decodeEncryptedSessionBundle(slot.encryptedSessionBundle, this.encryptionKeyHex);
    if (!decoded) {
      throw new InventoryError(
        409,
        "SLOT_NOT_CONNECTED",
        `Slot ${slot.slotCode} does not have a connected LagosLife session.`
      );
    }

    const liveData = await this.lagosLifeAdapter.fetchAccountData(decoded.cookie);
    if (!liveData.ok) {
      if (liveData.status === 401 || liveData.status === 403) {
        const updated = await this.prisma.gameAccount.update({
          where: { id: slot.id },
          data: { healthStatus: GameAccountHealth.SESSION_EXPIRED },
        });
        await this.prisma.auditLog.create({
          data: {
            actorUserId: input.actorUserId,
            actionType: "LAGOSLIFE_SESSION_EXPIRED_DETECTED",
            targetEntity: "game_accounts",
            targetId: slot.id,
            beforeState: { slotCode: slot.slotCode, healthStatus: slot.healthStatus },
            afterState: { slotCode: slot.slotCode, healthStatus: updated.healthStatus },
            reason: `LagosLife /api/save returned HTTP ${liveData.status}`,
            ipAddress: input.ipAddress,
          },
        });
        throw new InventoryError(
          401,
          "LAGOSLIFE_SESSION_EXPIRED",
          `LagosLife session for ${slot.slotCode} (@${decoded.username}) has expired. Please reconnect.`
        );
      }

      throw new InventoryError(
        502,
        "LAGOSLIFE_SYNC_FAILED",
        liveData.error ?? `Failed to sync live balance for ${slot.slotCode}.`
      );
    }

    const nowIso = new Date().toISOString();
    const updatedBundle: StoredSessionBundle = {
      ...decoded,
      uid: liveData.ownerUid || decoded.uid,
      simName: liveData.name ?? decoded.simName,
      verifiedAt: nowIso,
    };
    const encryptedSessionBundle = encodeEncryptedSessionBundle(
      updatedBundle,
      this.encryptionKeyHex
    );
    await this.prisma.gameAccount.update({
      where: { id: slot.id },
      data: { encryptedSessionBundle },
    });

    const syncResult = await this.syncAccountBalance({
      actorUserId: input.actorUserId,
      slotCode: slot.slotCode,
      observedBalance: liveData.money ?? 0n,
      healthStatus: GameAccountHealth.ACTIVE,
      lagoslifeUsername: decoded.username,
      reason: `Live LagosLife /api/save sync (@${decoded.username})`,
      ipAddress: input.ipAddress,
    });

    return {
      slotCode: slot.slotCode,
      lagoslifeUsername: decoded.username,
      observedBalance: syncResult.account.lastKnownBalance.toFixed(0),
      reservedForOrders: syncResult.account.reservedForOrders.toFixed(0),
      healthStatus: syncResult.account.healthStatus,
      lastSyncedAt: syncResult.account.lastSyncedAt?.toISOString() ?? nowIso,
      discrepancy: syncResult.discrepancy,
    };
  }

  async syncAllLiveBalances(input: {
    actorUserId: string;
    ipAddress?: string;
  }) {
    const accounts = await this.prisma.gameAccount.findMany({
      orderBy: { slotCode: "asc" },
    });

    const results: Array<{
      slotCode: string;
      status: "SYNCED" | "SKIPPED_DISCONNECTED" | "SESSION_EXPIRED" | "ERROR";
      observedBalance?: string;
      discrepancy?: { id: string; deltaAmount: string } | null;
      error?: string;
    }> = [];

    for (const acc of accounts) {
      const decoded = decodeEncryptedSessionBundle(
        acc.encryptedSessionBundle,
        this.encryptionKeyHex
      );
      if (!decoded) {
        results.push({
          slotCode: acc.slotCode,
          status: "SKIPPED_DISCONNECTED",
        });
        continue;
      }

      try {
        const res = await this.syncLiveSlotBalance({
          actorUserId: input.actorUserId,
          slotCode: acc.slotCode,
          ipAddress: input.ipAddress,
        });
        results.push({
          slotCode: acc.slotCode,
          status: "SYNCED",
          observedBalance: res.observedBalance,
          discrepancy: res.discrepancy,
        });
      } catch (err) {
        if (err instanceof InventoryError && err.code === "LAGOSLIFE_SESSION_EXPIRED") {
          results.push({
            slotCode: acc.slotCode,
            status: "SESSION_EXPIRED",
            error: err.message,
          });
        } else {
          results.push({
            slotCode: acc.slotCode,
            status: "ERROR",
            error: (err as Error).message,
          });
        }
      }
    }

    const overview = await this.getInventoryOverview();
    return {
      results,
      overview,
    };
  }

  async resolvePlayerUsername(query: string) {
    const cleanQuery = query.trim();
    if (!cleanQuery) {
      throw new InventoryError(400, "QUERY_REQUIRED", "Player username or ID query is required.");
    }

    const accounts = await this.prisma.gameAccount.findMany({
      orderBy: { slotCode: "asc" },
    });
    let activeCookie: string | undefined;
    for (const acc of accounts) {
      const decoded = decodeEncryptedSessionBundle(
        acc.encryptedSessionBundle,
        this.encryptionKeyHex
      );
      if (decoded?.cookie && acc.healthStatus !== GameAccountHealth.SESSION_EXPIRED) {
        activeCookie = decoded.cookie;
        break;
      }
    }

    const resolved = await this.lagosLifeAdapter.resolveTargetIdAsync(cleanQuery, activeCookie);
    if (!resolved) {
      throw new InventoryError(404, "PLAYER_NOT_FOUND", `Could not find LagosLife player "${cleanQuery}".`);
    }
    return resolved;
  }
}

