import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  CommissionLedgerEntryType,
  CommissionRuleStatus,
  CommissionSettlementStatus,
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
  PartnerStatus,
  Prisma,
  ProofVerificationStatus,
  RefundFinancialStatus,
  RefundScope,
  RefundStatus,
  UserRole,
} from "@prisma/client";
import { calculateCommissionSplit } from "@bigola/shared";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import type { AuditLogRecord, AuditLogStore } from "./lib/audit.js";
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  generateTotpCode,
  generateTotpSecret,
  hashPassword,
  hashSessionToken,
} from "./lib/crypto.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import type {
  AuthStore,
  AuthUserRecord,
  PlatformStore,
  SessionRecord,
} from "./lib/repositories.js";
import { CommissionService } from "./services/commission.js";
import { InventoryService } from "./services/inventory.js";
import { LagosLifeAdapter, MAX_LAGOSLIFE_TRANSFER_CHUNK as MAX_CHUNK_AMOUNT } from "./services/lagoslife.js";
import {
  ACCOUNT_COOLDOWN_MS,
  AccountTransferCoordinator,
  DisbursementService,
} from "./services/disbursement.js";
import { OperationsService } from "./services/operations.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function toDecimal(val: bigint | number | string | Prisma.Decimal): Prisma.Decimal {
  if (val instanceof Prisma.Decimal) return val;
  return new Prisma.Decimal(val.toString());
}

/**
 * Isolated in-memory harness for Stage 8D End-to-End Integration, Financial Safety & Security Audit.
 * Never connects to or mutates the shared/production PostgreSQL database or live LagosLife API.
 */
function createStage8DTestHarness(opts?: { disbursementEnabled?: boolean }) {
  const env = loadEnv({
    NODE_ENV: "test",
    OWNER_REQUIRE_2FA: "true",
    DISBURSEMENT_ENABLED: opts?.disbursementEnabled ? "true" : "false",
    ENCRYPTION_KEY_HEX: TEST_ENCRYPTION_KEY,
  });

  const ownerMfaSecret = generateTotpSecret();
  const ownerId = crypto.randomUUID();
  const ownerNo2faId = crypto.randomUUID();
  const partnerUserId = crypto.randomUUID();
  const partnerId = crypto.randomUUID();

  const users = new Map<string, AuthUserRecord>();
  const sessions = new Map<string, SessionRecord>();
  const auditLogs: AuditLogRecord[] = [];

  users.set(ownerId, {
    id: ownerId,
    email: "owner@bigola.local",
    passwordHash: "unused",
    role: UserRole.OWNER,
    isActive: true,
    mfaEnabled: true,
    mfaSecretEncrypted: encryptSensitiveValue(ownerMfaSecret, env.ENCRYPTION_KEY_HEX),
  });

  users.set(ownerNo2faId, {
    id: ownerNo2faId,
    email: "owner-no2fa@bigola.local",
    passwordHash: "unused",
    role: UserRole.OWNER,
    isActive: true,
    mfaEnabled: false,
    mfaSecretEncrypted: null,
  });

  users.set(partnerUserId, {
    id: partnerUserId,
    email: "partner@bigola.local",
    passwordHash: "unused",
    role: UserRole.PARTNER,
    isActive: true,
    mfaEnabled: false,
    mfaSecretEncrypted: null,
  });

  const ownerToken = "stage8d-owner-token";
  sessions.set(
    hashSessionToken(ownerToken, env.SESSION_SECRET),
    {
      id: crypto.randomUUID(),
      userId: ownerId,
      tokenHash: hashSessionToken(ownerToken, env.SESSION_SECRET),
      mfaVerified: true,
      ipAddress: "127.0.0.1",
      userAgent: "stage8d-test",
      expiresAt: new Date(Date.now() + 3600_000),
      revokedAt: null,
    }
  );

  const ownerNo2faToken = "stage8d-owner-no2fa-token";
  sessions.set(
    hashSessionToken(ownerNo2faToken, env.SESSION_SECRET),
    {
      id: crypto.randomUUID(),
      userId: ownerNo2faId,
      tokenHash: hashSessionToken(ownerNo2faToken, env.SESSION_SECRET),
      mfaVerified: false,
      ipAddress: "127.0.0.1",
      userAgent: "stage8d-test",
      expiresAt: new Date(Date.now() + 3600_000),
      revokedAt: null,
    }
  );

  const partnerToken = "stage8d-partner-token";
  sessions.set(
    hashSessionToken(partnerToken, env.SESSION_SECRET),
    {
      id: crypto.randomUUID(),
      userId: partnerUserId,
      tokenHash: hashSessionToken(partnerToken, env.SESSION_SECRET),
      mfaVerified: false,
      ipAddress: "127.0.0.1",
      userAgent: "stage8d-test",
      expiresAt: new Date(Date.now() + 3600_000),
      revokedAt: null,
    }
  );

  const authStore: AuthStore = {
    async findUserByEmail(email) {
      for (const u of users.values()) {
        if (u.email.toLowerCase() === email.toLowerCase()) return u;
      }
      return null;
    },
    async findUserById(id) {
      return users.get(id) ?? null;
    },
    async createUser(input) {
      const u: AuthUserRecord = {
        id: crypto.randomUUID(),
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        role: input.role,
        isActive: true,
        mfaEnabled: false,
        mfaSecretEncrypted: null,
      };
      users.set(u.id, u);
      return u;
    },
    async updateUserMfa(userId, mfaSecretEncrypted, mfaEnabled) {
      const u = users.get(userId);
      if (u) {
        u.mfaSecretEncrypted = mfaSecretEncrypted;
        u.mfaEnabled = mfaEnabled;
      }
    },
    async createSession(s) {
      const rec: SessionRecord = { ...s, id: crypto.randomUUID(), revokedAt: null };
      sessions.set(rec.tokenHash, rec);
      return rec;
    },
    async findSessionByTokenHash(tokenHash) {
      const s = sessions.get(tokenHash);
      if (!s) return null;
      const u = users.get(s.userId);
      if (!u) return null;
      return { ...s, user: u } as any;
    },
    async markSessionMfaVerified(sessionId) {
      for (const s of sessions.values()) {
        if (s.id === sessionId) s.mfaVerified = true;
      }
    },
    async revokeSession(sessionId) {
      for (const s of sessions.values()) {
        if (s.id === sessionId) s.revokedAt = new Date();
      }
    },
  };

  const auditStore: AuditLogStore = {
    async record(entry) {
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
    async listRecent(limit) {
      return auditLogs.slice(-limit).reverse();
    },
  };

  const platformStore: PlatformStore = {
    async getPartnerOverview() {
      return {
        partnerId,
        referralCode: "BGO-PARTNER1",
        displayName: "Stage 8D Partner",
        attributedCustomerCount: 1,
        commissionRule: "50/50 gross verified payment split (Category A)",
      };
    },
    async listPartnerAttributedCustomers() {
      return [];
    },
    async getCustomerOverview(userId) {
      return { userId, message: "Customer portal ready." };
    },
    async getOwnerOverview() {
      return {
        disbursementEnabled: env.DISBURSEMENT_ENABLED,
        totalUsers: users.size,
        totalPartners: 1,
        recentAuditCount: auditLogs.length,
      };
    },
    async getSettings() {
      return [];
    },
    async updateSetting(key, value, description) {
      return { key, value, description, updatedAt: new Date() };
    },
  };

  // In-memory relational tables
  const gameAccounts = new Map<string, any>();
  const orders = new Map<string, any>();
  const customers = new Map<string, any>();
  const partners = new Map<string, any>();
  const reservations = new Map<string, any>();
  const inventoryLedger: any[] = [];
  const disbursementJobs = new Map<string, any>();
  const disbursementChunks = new Map<string, any>();
  const notifications: any[] = [];
  const paymentProofs = new Map<string, any>();
  const commissionRules = new Map<string, any>();
  const commissionRecords = new Map<string, any>();
  const commissionLedgerEntries: any[] = [];
  const refundRequests = new Map<string, any>();
  const refundEvents: any[] = [];

  partners.set(partnerId, {
    id: partnerId,
    userId: partnerUserId,
    referralCode: "BGO-PARTNER1",
    displayName: "Stage 8D Partner",
    status: PartnerStatus.ACTIVE,
    canVerifyPayments: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const catARuleId = crypto.randomUUID();
  commissionRules.set(catARuleId, {
    id: catARuleId,
    category: CustomerCategory.CATEGORY_A_PARTNER,
    status: CommissionRuleStatus.ACTIVE,
    partnerShareBps: 5000,
    ownerShareBps: 5000,
    effectiveFrom: new Date(Date.now() - 86400_000),
    createdAt: new Date(),
  });

  const catBRuleId = crypto.randomUUID();
  commissionRules.set(catBRuleId, {
    id: catBRuleId,
    category: CustomerCategory.CATEGORY_B_BIGOLA,
    status: CommissionRuleStatus.PENDING_RULE,
    partnerShareBps: null,
    ownerShareBps: null,
    effectiveFrom: new Date(Date.now() - 86400_000),
    createdAt: new Date(),
  });

  // Seed all 5 canonical LagosLife accounts (initially DISCONNECTED so Stage 8D.1 tests live authentication & sync)
  const slotConfigs = [
    {
      slotCode: "MAIN_TREASURY",
      label: "Main Treasury (bigola2823)",
      role: GameAccountRole.MAIN_TREASURY,
      username: "bigola2823",
      balance: 2_000_000_000_000n, // 2T
      target: 0n,
    },
    {
      slotCode: "RESERVE_1",
      label: "Reserve Account 1",
      role: GameAccountRole.RESERVE,
      username: "bigola_res1",
      balance: 1_500_000_000_000n, // 1.5T
      target: 70_000_000_000_000n,
    },
    {
      slotCode: "RESERVE_2",
      label: "Reserve Account 2",
      role: GameAccountRole.RESERVE,
      username: "bigola_res2",
      balance: 1_500_000_000_000n, // 1.5T
      target: 70_000_000_000_000n,
    },
    {
      slotCode: "RESERVE_3",
      label: "Reserve Account 3",
      role: GameAccountRole.RESERVE,
      username: "bigola_res3",
      balance: 1_000_000_000_000n, // 1T
      target: 70_000_000_000_000n,
    },
    {
      slotCode: "RESERVE_4",
      label: "Reserve Account 4",
      role: GameAccountRole.RESERVE,
      username: "bigola_res4",
      balance: 500_000_000_000n, // 500B
      target: 70_000_000_000_000n,
    },
  ];

  // Track live upstream balances on the mocked LagosLife server
  const liveUpstreamBalancesByUsername = new Map<string, bigint>();
  const cookieToUsername = new Map<string, string>();

  for (const cfg of slotConfigs) {
    const id = crypto.randomUUID();
    liveUpstreamBalancesByUsername.set(cfg.username, cfg.balance);
    cookieToUsername.set(`session_cookie_${cfg.slotCode}`, cfg.username);

    gameAccounts.set(id, {
      id,
      slotCode: cfg.slotCode,
      label: cfg.label,
      accountRole: cfg.role,
      lagoslifeUsername: cfg.slotCode === "MAIN_TREASURY" ? "bigola2823" : null,
      encryptedSessionBundle: null,
      targetReserveAmount: toDecimal(cfg.target),
      logicalAllocationAmount: toDecimal(cfg.target),
      lastKnownBalance: toDecimal(0n),
      reservedForOrders: toDecimal(0n),
      healthStatus: GameAccountHealth.UNCONFIGURED,
      lastSyncedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  function hydrateOrder(o: any) {
    if (!o) return null;
    const customer = customers.get(o.customerId) ?? null;
    const partner = o.partnerId ? partners.get(o.partnerId) ?? null : null;
    const orderReservations = [...reservations.values()]
      .filter((r) => r.orderId === o.id)
      .map((r) => ({
        ...r,
        gameAccount: gameAccounts.get(r.gameAccountId) ?? null,
      }));
    const jobs = [...disbursementJobs.values()]
      .filter((j) => j.orderId === o.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((j) => ({
        ...j,
        chunks: [...disbursementChunks.values()]
          .filter((c) => c.jobId === j.id)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((c) => ({
            ...c,
            sourceAccount: gameAccounts.get(c.sourceAccountId) ?? null,
          })),
      }));
    const proofs = [...paymentProofs.values()].filter((p) => p.orderId === o.id);
    const commRec = [...commissionRecords.values()].find((c) => c.orderId === o.id) ?? null;
    const hydratedComm = commRec
      ? {
          ...commRec,
          ledgerEntries: commissionLedgerEntries.filter(
            (e) => e.commissionRecordId === commRec.id
          ),
        }
      : null;

    return {
      ...o,
      customer,
      partner,
      reservations: orderReservations,
      paymentProofs: proofs,
      verificationDecisions: [],
      paymentExceptions: [],
      disbursementJobs: jobs,
      manualFulfilments: [],
      refundRequests: [...refundRequests.values()].filter((r) => r.orderId === o.id),
      refundEvents: refundEvents.filter((e) => e.orderId === o.id),
      supportTickets: [],
      commissionRecord: hydratedComm,
    };
  }

  const fakePrisma: any = {
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(fakePrisma),
    $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join(" ");
      if (sql.includes("FROM game_accounts")) {
        const slotCode = String(values[0] ?? "");
        const row = [...gameAccounts.values()].find((a) => a.slotCode === slotCode);
        if (!row) return [];
        return [
          {
            id: row.id,
            slot_code: row.slotCode,
            last_known_balance: row.lastKnownBalance.toFixed(0),
            reserved_for_orders: row.reservedForOrders.toFixed(0),
            health_status: row.healthStatus,
            lagoslife_username: row.lagoslifeUsername,
            last_synced_at: row.lastSyncedAt,
          },
        ];
      }
      if (sql.includes("FROM orders")) {
        const orderId = values[0];
        const o = orders.get(orderId);
        if (!o) return [];
        return [
          {
            id: o.id,
            order_number: o.orderNumber,
            status: o.status,
            verified_gross_fiat_kobo: o.verifiedGrossFiatKobo,
            confirmed_refunded_kobo: o.confirmedRefundedKobo,
            funding_cycle: o.fundingCycle ?? 1,
            customer_id: o.customerId,
            partner_id: o.partnerId,
          },
        ];
      }
      if (sql.includes("FROM refund_requests")) {
        const refundId = values[0];
        const r = refundRequests.get(refundId);
        if (!r) return [];
        return [
          {
            id: r.id,
            order_id: r.orderId,
            scope: r.scope,
            current_status: r.currentStatus,
            requested_amount_kobo: r.requestedAmountKobo,
          },
        ];
      }
      return [];
    },
    platformSetting: {
      findUnique: async () => null,
      findMany: async () => [],
    },
    user: {
      findMany: async () => [...users.values()],
      findUnique: async ({ where }: any) => {
        if (where.id) return users.get(where.id) ?? null;
        if (where.email) {
          for (const u of users.values()) {
            if (u.email === where.email) return u;
          }
        }
        return null;
      },
    },
    customer: {
      findUnique: async ({ where }: any) => {
        if (where.id) return customers.get(where.id) ?? null;
        if (where.userId) {
          for (const c of customers.values()) {
            if (c.userId === where.userId) return c;
          }
        }
        return null;
      },
      create: async ({ data }: any) => {
        const rec = {
          id: crypto.randomUUID(),
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        customers.set(rec.id, rec);
        return rec;
      },
    },
    partner: {
      findUnique: async ({ where }: any) => {
        if (where.id) return partners.get(where.id) ?? null;
        if (where.userId) {
          for (const p of partners.values()) {
            if (p.userId === where.userId) return p;
          }
        }
        if (where.referralCode) {
          for (const p of partners.values()) {
            if (p.referralCode === where.referralCode) return p;
          }
        }
        return null;
      },
    },
    gameAccount: {
      findMany: async () => {
        return [...gameAccounts.values()].sort((a, b) =>
          (a.slotCode ?? "").localeCompare(b.slotCode ?? "")
        );
      },
      findUnique: async ({ where }: any) => {
        if (where.id) return gameAccounts.get(where.id) ?? null;
        if (where.slotCode) {
          for (const acc of gameAccounts.values()) {
            if (acc.slotCode === where.slotCode) return acc;
          }
        }
        return null;
      },
      findFirst: async ({ where }: any) => {
        for (const acc of gameAccounts.values()) {
          if (where.slotCode && acc.slotCode === where.slotCode) return acc;
          if (where.id?.not && acc.id === where.id.not) continue;
          if (where.NOT?.id && acc.id === where.NOT.id) continue;
          if (
            where.lagoslifeUsername?.equals &&
            acc.lagoslifeUsername?.toLowerCase() ===
              where.lagoslifeUsername.equals.toLowerCase()
          ) {
            return acc;
          }
        }
        return null;
      },
      update: async ({ where, data }: any) => {
        const acc = where.id
          ? gameAccounts.get(where.id)
          : [...gameAccounts.values()].find((a) => a.slotCode === where.slotCode);
        if (!acc) throw new Error("GameAccount not found");
        if (data.lagoslifeUsername !== undefined) acc.lagoslifeUsername = data.lagoslifeUsername;
        if (data.encryptedSessionBundle !== undefined)
          acc.encryptedSessionBundle = data.encryptedSessionBundle;
        if (data.healthStatus !== undefined) acc.healthStatus = data.healthStatus;
        if (data.lastSyncedAt !== undefined) acc.lastSyncedAt = data.lastSyncedAt;
        if (data.lastKnownBalance !== undefined) {
          acc.lastKnownBalance = toDecimal(data.lastKnownBalance);
        }
        if (data.reservedForOrders !== undefined) {
          if (typeof data.reservedForOrders === "object" && data.reservedForOrders.decrement) {
            const cur = BigInt(acc.reservedForOrders.toFixed(0));
            const dec = BigInt(data.reservedForOrders.decrement);
            acc.reservedForOrders = toDecimal(cur > dec ? cur - dec : 0n);
          } else {
            acc.reservedForOrders = toDecimal(data.reservedForOrders);
          }
        }
        acc.updatedAt = new Date();
        return acc;
      },
    },
    order: {
      findUnique: async ({ where }: any) => {
        const o = orders.get(where.id);
        return hydrateOrder(o);
      },
      findUniqueOrThrow: async ({ where }: any) => {
        const o = orders.get(where.id);
        if (!o) throw new Error("Order not found");
        return hydrateOrder(o);
      },
      findMany: async ({ where }: any = {}) => {
        let list = [...orders.values()];
        if (where?.customerId) {
          list = list.filter((o) => o.customerId === where.customerId);
        }
        if (where?.status) {
          if (typeof where.status === "string") {
            list = list.filter((o) => o.status === where.status);
          } else if (where.status.in) {
            list = list.filter((o) => where.status.in.includes(o.status));
          }
        }
        return list.map((o) => hydrateOrder(o));
      },
      update: async ({ where, data }: any) => {
        const o = orders.get(where.id);
        if (!o) throw new Error("Order not found");
        if (data.status !== undefined) o.status = data.status;
        if (data.gameAmountDelivered !== undefined) {
          o.gameAmountDelivered = toDecimal(data.gameAmountDelivered);
        }
        if (data.fulfilledAmount !== undefined) {
          o.fulfilledAmount = toDecimal(data.fulfilledAmount);
        }
        if (data.verifiedGrossFiatKobo !== undefined) {
          o.verifiedGrossFiatKobo = BigInt(data.verifiedGrossFiatKobo);
        }
        if (data.confirmedRefundedKobo !== undefined) {
          o.confirmedRefundedKobo = BigInt(data.confirmedRefundedKobo);
        }
        if (data.refundFinancialStatus !== undefined) {
          o.refundFinancialStatus = data.refundFinancialStatus;
        }
        o.updatedAt = new Date();
        return hydrateOrder(o);
      },
    },
    inventoryReservation: {
      findMany: async ({ where }: any) => {
        return [...reservations.values()].filter((r) => {
          if (where?.orderId && r.orderId !== where.orderId) return false;
          if (where?.gameAccountId && r.gameAccountId !== where.gameAccountId) return false;
          if (where?.status && r.status !== where.status) return false;
          return true;
        });
      },
      update: async ({ where, data }: any) => {
        const r = reservations.get(where.id);
        if (!r) throw new Error("Reservation not found");
        if (data.amount !== undefined) r.amount = toDecimal(data.amount);
        if (data.status !== undefined) r.status = data.status;
        if (data.releasedAt !== undefined) r.releasedAt = data.releasedAt;
        if (data.releaseReason !== undefined) r.releaseReason = data.releaseReason;
        return r;
      },
    },
    inventoryLedger: {
      findMany: async ({ where }: any = {}) => {
        if (where?.gameAccountId) {
          return inventoryLedger.filter(
            (e) =>
              e.gameAccountId === where.gameAccountId &&
              (!where.entryType || e.entryType === where.entryType)
          );
        }
        return inventoryLedger.slice(-25).map((e) => {
          const acc = gameAccounts.get(e.gameAccountId);
          return {
            ...e,
            gameAccount: { slotCode: acc?.slotCode ?? "MAIN_TREASURY" },
          };
        });
      },
      create: async ({ data }: any) => {
        const entry = {
          id: crypto.randomUUID(),
          ...data,
          deltaAmount: toDecimal(data.deltaAmount),
          balanceAfter: toDecimal(data.balanceAfter),
          createdAt: new Date(),
        };
        inventoryLedger.push(entry);
        return entry;
      },
    },
    inventoryDiscrepancy: {
      count: async () => 0,
      findMany: async () => [],
      create: async ({ data }: any) => ({ id: crypto.randomUUID(), ...data }),
    },
    manualFulfilmentRecord: {
      findMany: async () => [],
    },
    disbursementJob: {
      create: async ({ data }: any) => {
        const job = {
          id: crypto.randomUUID(),
          orderId: data.orderId,
          authorizedById: data.authorizedById,
          status: data.status,
          totalAmount: toDecimal(data.totalAmount),
          deliveredAmount: toDecimal(data.deliveredAmount ?? 0),
          totalChunks: data.totalChunks,
          completedChunks: data.completedChunks ?? 0,
          startedAt: null,
          completedAt: null,
          pausedReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        disbursementJobs.set(job.id, job);
        return job;
      },
      findUnique: async ({ where, include }: any) => {
        const job = disbursementJobs.get(where.id);
        if (!job) return null;
        const copy: any = { ...job };
        if (include?.order) copy.order = orders.get(job.orderId) ?? null;
        if (include?.chunks) {
          copy.chunks = [...disbursementChunks.values()]
            .filter((c) => c.jobId === job.id)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map((c) => ({
              ...c,
              sourceAccount: gameAccounts.get(c.sourceAccountId) ?? null,
            }));
        }
        return copy;
      },
      findMany: async ({ where, include }: any = {}) => {
        const jobs = [...disbursementJobs.values()].filter((j) =>
          where?.orderId ? j.orderId === where.orderId : true
        );
        return jobs.map((job) => {
          const copy: any = { ...job };
          if (include?.chunks) {
            copy.chunks = [...disbursementChunks.values()]
              .filter((c) => c.jobId === job.id)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
              .map((c) => ({
                ...c,
                sourceAccount: gameAccounts.get(c.sourceAccountId) ?? null,
              }));
          }
          return copy;
        });
      },
      update: async ({ where, data }: any) => {
        const job = disbursementJobs.get(where.id);
        if (!job) throw new Error("Job not found");
        if (data.status !== undefined) job.status = data.status;
        if (data.deliveredAmount !== undefined) job.deliveredAmount = toDecimal(data.deliveredAmount);
        if (data.completedChunks !== undefined) job.completedChunks = data.completedChunks;
        if (data.startedAt !== undefined) job.startedAt = data.startedAt;
        if (data.completedAt !== undefined) job.completedAt = data.completedAt;
        if (data.pausedReason !== undefined) job.pausedReason = data.pausedReason;
        job.updatedAt = new Date();
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
          chunkIndex: data.chunkIndex ?? seq,
          amount: toDecimal(data.amount),
          recipientUsername: data.recipientUsername,
          resolvedTargetId: data.resolvedTargetId ?? null,
          idempotencyKey: data.idempotencyKey,
          status: data.status,
          attemptCount: data.attemptCount ?? 0,
          balanceBefore: data.balanceBefore ? toDecimal(data.balanceBefore) : null,
          balanceAfter: data.balanceAfter ? toDecimal(data.balanceAfter) : null,
          externalResponse: data.externalResponse ?? null,
          errorDetails: data.errorDetails ?? null,
          sentAt: data.sentAt ?? null,
          confirmedAt: data.confirmedAt ?? null,
          createdAt: new Date(Date.now() + seq),
        };
        disbursementChunks.set(chunk.id, chunk);
        return chunk;
      },
      findUnique: async ({ where, include }: any) => {
        const chunk = disbursementChunks.get(where.id);
        if (!chunk) return null;
        const copy: any = { ...chunk };
        if (include?.sourceAccount) {
          copy.sourceAccount = gameAccounts.get(chunk.sourceAccountId) ?? null;
        }
        return copy;
      },
      findMany: async ({ where }: any) => {
        return [...disbursementChunks.values()]
          .filter((c) => (where?.jobId ? c.jobId === where.jobId : true))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
      update: async ({ where, data }: any) => {
        const chunk = disbursementChunks.get(where.id);
        if (!chunk) throw new Error("Chunk not found");
        if (data.status !== undefined) chunk.status = data.status;
        if (data.attemptCount !== undefined) chunk.attemptCount = data.attemptCount;
        if (data.balanceBefore !== undefined)
          chunk.balanceBefore = data.balanceBefore ? toDecimal(data.balanceBefore) : null;
        if (data.balanceAfter !== undefined)
          chunk.balanceAfter = data.balanceAfter ? toDecimal(data.balanceAfter) : null;
        if (data.externalResponse !== undefined) chunk.externalResponse = data.externalResponse;
        if (data.errorDetails !== undefined) chunk.errorDetails = data.errorDetails;
        if (data.sentAt !== undefined) chunk.sentAt = data.sentAt;
        if (data.confirmedAt !== undefined) chunk.confirmedAt = data.confirmedAt;
        return chunk;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const chunk of disbursementChunks.values()) {
          if (where.jobId && chunk.jobId !== where.jobId) continue;
          if (where.status?.in && !where.status.in.includes(chunk.status)) continue;
          if (data.status !== undefined) chunk.status = data.status;
          if (data.errorDetails !== undefined) chunk.errorDetails = data.errorDetails;
          count++;
        }
        return { count };
      },
    },
    commissionRule: {
      findFirst: async ({ where }: any) => {
        for (const r of commissionRules.values()) {
          if (where.category && r.category !== where.category) continue;
          if (where.status && r.status !== where.status) continue;
          return r;
        }
        return null;
      },
    },
    commissionRecord: {
      create: async ({ data }: any) => {
        const rec = {
          id: crypto.randomUUID(),
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        commissionRecords.set(rec.id, rec);
        return rec;
      },
      findUnique: async ({ where, include }: any) => {
        let found: any = null;
        if (where.id) found = commissionRecords.get(where.id) ?? null;
        if (where.orderId) {
          found = [...commissionRecords.values()].find((c) => c.orderId === where.orderId) ?? null;
        }
        if (!found) return null;
        if (include?.ledgerEntries) {
          return {
            ...found,
            ledgerEntries: commissionLedgerEntries.filter(
              (e) => e.commissionRecordId === found.id
            ),
          };
        }
        return found;
      },
      update: async ({ where, data }: any) => {
        const rec = commissionRecords.get(where.id);
        if (!rec) throw new Error("CommissionRecord not found");
        if (data.settlementStatus !== undefined) rec.settlementStatus = data.settlementStatus;
        rec.updatedAt = new Date();
        return rec;
      },
    },
    commissionLedgerEntry: {
      create: async ({ data }: any) => {
        const entry = {
          id: crypto.randomUUID(),
          fundingCycle: data.fundingCycle ?? 1,
          ...data,
          createdAt: new Date(),
        };
        commissionLedgerEntries.push(entry);
        return entry;
      },
    },
    refundRequest: {
      create: async ({ data }: any) => {
        const req = {
          id: crypto.randomUUID(),
          ...data,
          confirmIdempotencyKey: null,
          confirmRequestHash: null,
          confirmedRefundReference: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        refundRequests.set(req.id, req);
        return req;
      },
      findUnique: async ({ where }: any) => {
        if (where.id) return refundRequests.get(where.id) ?? null;
        if (where.confirmIdempotencyKey) {
          for (const r of refundRequests.values()) {
            if (r.confirmIdempotencyKey === where.confirmIdempotencyKey) return r;
          }
        }
        if (where.confirmedRefundReference) {
          for (const r of refundRequests.values()) {
            if (r.confirmedRefundReference === where.confirmedRefundReference) return r;
          }
        }
        return null;
      },
      update: async ({ where, data }: any) => {
        const r = refundRequests.get(where.id);
        if (!r) throw new Error("RefundRequest not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      },
    },
    refundEvent: {
      create: async ({ data }: any) => {
        const ev = { id: crypto.randomUUID(), ...data, createdAt: new Date() };
        refundEvents.push(ev);
        return ev;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        return auditStore.record({
          actorUserId: data.actorUserId,
          actionType: data.actionType,
          targetEntity: data.targetEntity,
          targetId: data.targetId,
          beforeState: data.beforeState,
          afterState: data.afterState,
          reason: data.reason,
          ipAddress: data.ipAddress,
        });
      },
    },
    notification: {
      create: async ({ data }: any) => {
        const n = { id: crypto.randomUUID(), ...data, createdAt: new Date() };
        notifications.push(n);
        return n;
      },
      createMany: async ({ data }: any) => {
        for (const item of data) {
          notifications.push({ id: crypto.randomUUID(), ...item, createdAt: new Date() });
        }
        return { count: data.length };
      },
    },
  };

  // Mocked LagosLife upstream HTTP behavior
  let nextSendBehavior: "SUCCESS" | "RATE_LIMIT_429" | "TIMEOUT_NOT_DEDUCTED" = "SUCCESS";
  const sendCalls: Array<{ to: string; amount: string; cookie?: string }> = [];

  const mockFetch: typeof globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(urlStr);
    const headers = new Headers(init?.headers);
    const cookieHeader = headers.get("cookie") ?? "";

    if (u.pathname === "/api/auth/login" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      const uname = String(body.username ?? "").trim();
      const matchedCfg = slotConfigs.find((s) => s.username === uname);
      if (!matchedCfg || body.password !== "ValidPass123!") {
        return new Response(JSON.stringify({ error: "Invalid credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, user: { username: uname } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": `session_cookie_${matchedCfg.slotCode}=active; Path=/; HttpOnly`,
        },
      });
    }

    if (u.pathname === "/api/auth/me") {
      let matchedUsername: string | null = null;
      for (const cfg of slotConfigs) {
        if (cookieHeader.includes(`session_cookie_${cfg.slotCode}`)) {
          matchedUsername = cfg.username;
          break;
        }
      }
      if (!matchedUsername) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          user: { id: `id_${matchedUsername}`, username: matchedUsername, name: matchedUsername },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (u.pathname === "/api/save") {
      let matchedUsername: string | null = null;
      for (const cfg of slotConfigs) {
        if (cookieHeader.includes(`session_cookie_${cfg.slotCode}`)) {
          matchedUsername = cfg.username;
          break;
        }
      }
      if (!matchedUsername) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const bal = liveUpstreamBalancesByUsername.get(matchedUsername) ?? 0n;
      return new Response(
        JSON.stringify({
          game: {
            money: Number(bal),
            sim: { name: matchedUsername },
            owner: `id_${matchedUsername}`,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (u.pathname === "/api/players") {
      return new Response(
        JSON.stringify({
          players: [
            {
              id: "bc745837935d45efbf47",
              username: "milespete",
              name: "Miles Pete",
              cash: 500_000_000,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (u.pathname === "/api/send" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      sendCalls.push({
        to: String(body.to),
        amount: String(body.amount),
        cookie: cookieHeader,
      });

      let matchedUsername: string | null = null;
      for (const cfg of slotConfigs) {
        if (cookieHeader.includes(`session_cookie_${cfg.slotCode}`)) {
          matchedUsername = cfg.username;
          break;
        }
      }

      if (nextSendBehavior === "RATE_LIMIT_429") {
        nextSendBehavior = "SUCCESS";
        return new Response(
          JSON.stringify({ error: "Too many transfers. Please wait 30s before sending again." }),
          { status: 429, headers: { "content-type": "application/json" } }
        );
      }

      if (nextSendBehavior === "TIMEOUT_NOT_DEDUCTED") {
        nextSendBehavior = "SUCCESS";
        throw new Error("Simulated upstream socket timeout before deduction");
      }

      const delta = BigInt(String(body.amount));
      if (matchedUsername) {
        const cur = liveUpstreamBalancesByUsername.get(matchedUsername) ?? 0n;
        liveUpstreamBalancesByUsername.set(matchedUsername, cur - delta);
      }
      const nextBal = matchedUsername ? liveUpstreamBalancesByUsername.get(matchedUsername) ?? 0n : 0n;
      return new Response(
        JSON.stringify({ ok: true, money: Number(nextBal) }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  };

  let virtualClockMs = 1_700_000_000_000;
  const sleepCallsMs: number[] = [];

  const lagosLifeAdapter = new LagosLifeAdapter({
    fetchImpl: mockFetch,
  });

  const inventoryService = new InventoryService(fakePrisma, {
    encryptionKeyHex: env.ENCRYPTION_KEY_HEX,
    lagosLifeAdapter,
  });

  const disbursementService = new DisbursementService(
    fakePrisma,
    env.ENCRYPTION_KEY_HEX,
    lagosLifeAdapter,
    {
      redis: null,
      disbursementEnabled: env.DISBURSEMENT_ENABLED,
      nowFn: () => virtualClockMs,
      sleepFn: async (ms: number) => {
        sleepCallsMs.push(ms);
        virtualClockMs += ms + 50;
      },
    }
  );
  const coordinator = disbursementService.coordinator;

  const operationsService = new OperationsService(fakePrisma, env.DISBURSEMENT_ENABLED);
  const commissionService = new CommissionService(fakePrisma);

  /**
   * Simulates Customer Registration + Attribution + Order Creation + Inventory Reservation +
   * Payment Proof Submission + Independent Payment Verification + Commission Accrual
   */
  async function createCustomerWithOrderAndVerifyPayment(input: {
    email: string;
    fullName: string;
    referredByPartner: boolean;
    recipientLagoslifeUsername: string;
    gameAmountRequested: bigint;
    fiatAmountKobo: bigint;
    reserveAcrossSlots: Array<{ slotCode: string; amount: bigint }>;
    verifyPayment: boolean;
  }) {
    const custUser = await authStore.createUser({
      email: input.email,
      passwordHash: await hashPassword("CustomerPass123!"),
      role: UserRole.CUSTOMER,
    });
    const rawToken = `cust-token-${custUser.id}`;
    await authStore.createSession({
      userId: custUser.id,
      tokenHash: hashSessionToken(rawToken, env.SESSION_SECRET),
      mfaVerified: false,
      ipAddress: "127.0.0.1",
      userAgent: "stage8d-customer",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const customer = await fakePrisma.customer.create({
      data: {
        userId: custUser.id,
        fullName: input.fullName,
        email: custUser.email,
        category: input.referredByPartner
          ? CustomerCategory.CATEGORY_A_PARTNER
          : CustomerCategory.CATEGORY_B_BIGOLA,
        attributedPartnerId: input.referredByPartner ? partnerId : null,
      },
    });

    const orderId = crypto.randomUUID();
    const orderObj = {
      id: orderId,
      orderNumber: `ORD-8D-${orderId.slice(0, 6).toUpperCase()}`,
      paymentReference: `BGL-8D-${orderId.slice(0, 6).toUpperCase()}`,
      channel: OrderChannel.ONLINE,
      orderType: OrderType.BULK,
      createdByUserId: custUser.id,
      customerId: customer.id,
      customerCategory: customer.category,
      partnerId: customer.attributedPartnerId,
      recipientLagoslifeUsername: input.recipientLagoslifeUsername,
      gameAmountRequested: toDecimal(input.gameAmountRequested),
      gameAmountDelivered: toDecimal(0n),
      fulfilledAmount: toDecimal(0n),
      fiatAmountKobo: input.fiatAmountKobo,
      verifiedGrossFiatKobo: 0n,
      confirmedRefundedKobo: 0n,
      refundFinancialStatus: RefundFinancialStatus.NONE,
      fundingCycle: 1,
      pricingSnapshot: {
        version: 1,
        orderType: "BULK",
        priceKoboPerTrillion: "100000000",
        gameAmount: input.gameAmountRequested.toString(),
        fiatKobo: input.fiatAmountKobo.toString(),
      },
      status: OrderStatus.AWAITING_PAYMENT,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    orders.set(orderId, orderObj);

    // Reserve inventory across specified slots
    for (const alloc of input.reserveAcrossSlots) {
      const slotAcc = [...gameAccounts.values()].find((a) => a.slotCode === alloc.slotCode);
      assert.ok(slotAcc, `Expected slot ${alloc.slotCode} to exist`);
      const resId = crypto.randomUUID();
      reservations.set(resId, {
        id: resId,
        orderId,
        gameAccountId: slotAcc.id,
        amount: toDecimal(alloc.amount),
        status: InventoryReservationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 3600_000),
        releasedAt: null,
        releaseReason: null,
        createdAt: new Date(),
      });
      const prevRes = BigInt(slotAcc.reservedForOrders.toFixed(0));
      slotAcc.reservedForOrders = toDecimal(prevRes + alloc.amount);
      const obs = BigInt(slotAcc.lastKnownBalance.toFixed(0));
      inventoryLedger.push({
        id: crypto.randomUUID(),
        gameAccountId: slotAcc.id,
        orderId,
        entryType: InventoryEntryType.ORDER_RESERVE,
        deltaAmount: toDecimal(-alloc.amount),
        balanceAfter: toDecimal(obs - (prevRes + alloc.amount)),
        createdById: custUser.id,
        notes: "Order inventory reservation",
        createdAt: new Date(),
      });
    }

    if (input.verifyPayment) {
      // Submit payment proof -> PAYMENT_SUBMITTED
      const proofId = crypto.randomUUID();
      paymentProofs.set(proofId, {
        id: proofId,
        orderId,
        submittedByUserId: custUser.id,
        bankReference: `OPAY-REF-${orderId.slice(0, 8)}`,
        senderAccountName: input.fullName,
        claimedAmountKobo: input.fiatAmountKobo,
        proofFileKey: `proofs/${orderId}.png`,
        verificationStatus: ProofVerificationStatus.APPROVED,
        verifiedByUserId: partnerUserId,
        verifiedAt: new Date(),
        createdAt: new Date(),
      });

      // Verify payment -> PAYMENT_VERIFIED -> Commission Accrual -> READY_FOR_FULFILMENT
      orderObj.status = OrderStatus.PAYMENT_VERIFIED;
      orderObj.verifiedGrossFiatKobo = input.fiatAmountKobo;

      const commRecord = await commissionService.recordCommissionForVerifiedOrder(
        orderId,
        partnerUserId
      );

      orderObj.status = OrderStatus.READY_FOR_FULFILMENT;
      return {
        customerUser: custUser,
        customerToken: rawToken,
        customer,
        order: orderObj,
        commissionRecord: commRecord,
      };
    }

    return {
      customerUser: custUser,
      customerToken: rawToken,
      customer,
      order: orderObj,
      commissionRecord: null,
    };
  }

  return {
    env,
    ownerId,
    ownerToken,
    ownerNo2faToken,
    partnerId,
    partnerUserId,
    partnerToken,
    authStore,
    auditStore,
    platformStore,
    auditLogs,
    gameAccounts,
    orders,
    reservations,
    inventoryLedger,
    disbursementJobs,
    disbursementChunks,
    commissionRecords,
    commissionLedgerEntries,
    refundRequests,
     prisma: fakePrisma,
    inventoryService,
    disbursementService,
    operationsService,
    commissionService,
    coordinator,
    sendCalls,
    sleepCallsMs,
    advanceClockMs(ms: number) {
      virtualClockMs += ms;
    },
    setNextSendBehavior(b: "SUCCESS" | "RATE_LIMIT_429" | "TIMEOUT_NOT_DEDUCTED") {
      nextSendBehavior = b;
    },
    createCustomerWithOrderAndVerifyPayment,
  };
}

test("Stage 8D: Final End-to-End Integration, Five-Account Fulfilment, Financial Safety & Security Audit", async () => {
  const harness = createStage8DTestHarness({ disbursementEnabled: true });
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
      operationsService: harness.operationsService,
      checkDb: async () => true,
    });

    // =========================================================================
    // 1. FIVE-ACCOUNT VERIFICATION (Authentication, Encryption, Identity & Sync)
    // =========================================================================
    const fiveSlots = [
      { slotCode: "MAIN_TREASURY", username: "bigola2823", expectedBalance: "2000000000000" },
      { slotCode: "RESERVE_1", username: "bigola_res1", expectedBalance: "1500000000000" },
      { slotCode: "RESERVE_2", username: "bigola_res2", expectedBalance: "1500000000000" },
      { slotCode: "RESERVE_3", username: "bigola_res3", expectedBalance: "1000000000000" },
      { slotCode: "RESERVE_4", username: "bigola_res4", expectedBalance: "500000000000" },
    ];

    // Verify MAIN_TREASURY rejects any username other than bigola2823
    const wrongMainRes = await app.inject({
      method: "POST",
      url: "/api/v1/owner/inventory/accounts/MAIN_TREASURY/connect/login",
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {
        username: "bigola_res1",
        password: "ValidPass123!",
      },
    });
    assert.equal(wrongMainRes.statusCode, 409);
    assert.equal(wrongMainRes.json().code, "SLOT_IDENTITY_MISMATCH");

    // Connect all 5 accounts independently via credentials, testing cross-slot duplicate prevention before RESERVE_2 is configured
    for (const s of fiveSlots) {
      if (s.slotCode === "RESERVE_2") {
        // RESERVE_2 is still unconfigured (lagoslifeUsername === null), so attempting to use RESERVE_1's username hits DUPLICATE_LAGOSLIFE_USERNAME
        const dupSlotRes = await app.inject({
          method: "POST",
          url: "/api/v1/owner/inventory/accounts/RESERVE_2/connect/login",
          headers: { authorization: `Bearer ${harness.ownerToken}` },
          payload: {
            username: "bigola_res1",
            password: "ValidPass123!",
          },
        });
        assert.equal(dupSlotRes.statusCode, 409);
        assert.equal(dupSlotRes.json().code, "DUPLICATE_LAGOSLIFE_USERNAME");
      }

      const connectRes = await app.inject({
        method: "POST",
        url: `/api/v1/owner/inventory/accounts/${s.slotCode}/connect/login`,
        headers: { authorization: `Bearer ${harness.ownerToken}` },
        payload: {
          username: s.username,
          password: "ValidPass123!",
        },
      });
      assert.equal(connectRes.statusCode, 200, `Failed connecting ${s.slotCode}: ${connectRes.body}`);
      const body = connectRes.json();
      assert.equal(body.status, "CONNECTED");
      assert.equal(body.lagoslifeUsername, s.username);
      assert.equal(body.observedBalance, s.expectedBalance);
      assert.ok(!JSON.stringify(body).includes("session_cookie_"));
      assert.ok(!JSON.stringify(body).includes("ValidPass123!"));
    }

    // Verify encrypted session storage at rest (AES-256-GCM) and sync-all-live across all 5 accounts
    for (const acc of harness.gameAccounts.values()) {
      assert.ok(acc.encryptedSessionBundle, `Expected encryptedSessionBundle on ${acc.slotCode}`);
      assert.ok(!String(acc.encryptedSessionBundle).includes("session_cookie_"));
      const decrypted = JSON.parse(
        decryptSensitiveValue(acc.encryptedSessionBundle, TEST_ENCRYPTION_KEY)
      );
      assert.ok(decrypted.cookie.includes(`session_cookie_${acc.slotCode}`));
    }

    const syncAllRes = await app.inject({
      method: "POST",
      url: "/api/v1/owner/inventory/sync-all-live",
      headers: { authorization: `Bearer ${harness.ownerToken}` },
    });
    assert.equal(syncAllRes.statusCode, 200);
    const syncAllBody = syncAllRes.json();
    assert.equal(syncAllBody.results.length, 5);
    assert.ok(syncAllBody.results.every((r: any) => r.status === "SYNCED"));
    assert.equal(syncAllBody.overview.totals.observedBalance, "6500000000000"); // 6.5T total across 5 accounts
    assert.equal(syncAllBody.overview.totals.netAvailableBalance, "6500000000000");

    // =========================================================================
    // 2. COMPLETE CUSTOMER JOURNEY (Category A 50/50 Split & Category B Pending Rule)
    // =========================================================================
    // 2A. Category A Partner-referred customer orders 250B (250,000,000,000) for NGN 25,000 (2,500,000 kobo)
    const catAJourney = await harness.createCustomerWithOrderAndVerifyPayment({
      email: "cat-a-buyer@bigola.local",
      fullName: "Category A Referred Buyer",
      referredByPartner: true,
      recipientLagoslifeUsername: "milespete",
      gameAmountRequested: 250_000_000_000n, // 250B
      fiatAmountKobo: 2_500_000n,
      reserveAcrossSlots: [
        { slotCode: "MAIN_TREASURY", amount: 150_000_000_000n },
        { slotCode: "RESERVE_1", amount: 100_000_000_000n },
      ],
      verifyPayment: true,
    });

    // Verify Category A 50/50 gross commission split
    assert.ok(catAJourney.commissionRecord);
    assert.equal(catAJourney.commissionRecord.category, CustomerCategory.CATEGORY_A_PARTNER);
    assert.equal(catAJourney.commissionRecord.settlementStatus, CommissionSettlementStatus.ACCRUED);
    assert.equal(catAJourney.commissionRecord.grossFiatKobo, 2_500_000n);
    assert.equal(catAJourney.commissionRecord.partnerEntitlementKobo, 1_250_000n);
    assert.equal(catAJourney.commissionRecord.ownerEntitlementKobo, 1_250_000n);

    // 2B. Category B Big Ola customer orders 100B (100,000,000,000) for NGN 10,000 (1,000,000 kobo)
    const catBJourney = await harness.createCustomerWithOrderAndVerifyPayment({
      email: "cat-b-buyer@bigola.local",
      fullName: "Category B Direct Buyer",
      referredByPartner: false,
      recipientLagoslifeUsername: "milespete",
      gameAmountRequested: 100_000_000_000n, // 100B
      fiatAmountKobo: 1_000_000n,
      reserveAcrossSlots: [{ slotCode: "RESERVE_2", amount: 100_000_000_000n }],
      verifyPayment: true,
    });

    // Verify Category B PENDING_RULE commission behavior
    assert.ok(catBJourney.commissionRecord);
    assert.equal(catBJourney.commissionRecord.category, CustomerCategory.CATEGORY_B_BIGOLA);
    assert.equal(catBJourney.commissionRecord.settlementStatus, CommissionSettlementStatus.PENDING_RULE);
    assert.equal(catBJourney.commissionRecord.partnerEntitlementKobo, null);
    assert.equal(catBJourney.commissionRecord.ownerEntitlementKobo, null);

    // =========================================================================
    // 3. CRITICAL FINANCIAL SAFETY CHECKS
    // =========================================================================
    // 3.1 Verify NO transfer or job occurred automatically after payment approval
    assert.equal(harness.disbursementJobs.size, 0);
    assert.equal(harness.sendCalls.length, 0);
    assert.equal(catAJourney.order.status, OrderStatus.READY_FOR_FULFILMENT);

    // 3.2 Verify payment verification cannot be bypassed (unpaid order cannot be authorized for disbursement)
    const unpaidOrderJourney = await harness.createCustomerWithOrderAndVerifyPayment({
      email: "unpaid-buyer@bigola.local",
      fullName: "Unpaid Buyer",
      referredByPartner: false,
      recipientLagoslifeUsername: "milespete",
      gameAmountRequested: 100_000_000_000n,
      fiatAmountKobo: 1_000_000n,
      reserveAcrossSlots: [{ slotCode: "RESERVE_3", amount: 100_000_000_000n }],
      verifyPayment: false,
    });

    const bypassRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${unpaidOrderJourney.order.id}/disbursements/authorize`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {
        allocations: [{ slotCode: "RESERVE_3", amount: "100000000000" }],
      },
    });
    assert.equal(bypassRes.statusCode, 409);
    assert.equal(bypassRes.json().code, "ORDER_NOT_READY_FOR_FULFILMENT");

    // 3.3 Explicit Owner Authorization + Multi-Account Split (MAIN_TREASURY 150B + RESERVE_1 100B = 250B -> 3 chunks)
    const authCatARes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${catAJourney.order.id}/disbursements/authorize`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {
        allocations: [
          { slotCode: "MAIN_TREASURY", amount: "150000000000" },
          { slotCode: "RESERVE_1", amount: "100000000000" },
        ],
        authorizationNote: "Internal Owner Authorization Note - Confidential",
      },
    });
    assert.equal(authCatARes.statusCode, 201);
    const catAJob = authCatARes.json().job;
    assert.equal(catAJob.totalChunks, 3);
    assert.equal(catAJob.chunks[0].amount, "100000000000"); // MAIN_TREASURY 100B
    assert.equal(catAJob.chunks[1].amount, "50000000000"); // MAIN_TREASURY 50B
    assert.equal(catAJob.chunks[2].amount, "100000000000"); // RESERVE_1 100B
    assert.ok(
      catAJob.chunks.every((c: any) => BigInt(c.amount) <= MAX_CHUNK_AMOUNT),
      "Every chunk must respect the 100B maximum limit"
    );

    // 3.4 Test 429 rate-limit handling safely on first execution attempt
    harness.setNextSendBehavior("RATE_LIMIT_429");
    const rateLimitExecRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${catAJob.id}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { maxChunksToProcess: 1, waitForCooldown: false },
    });
    assert.equal(rateLimitExecRes.statusCode, 200);
    const after429Job = rateLimitExecRes.json().job;
    assert.equal(after429Job.completedChunks, 0);
    assert.equal(after429Job.chunks[0].status, DisbursementChunkStatus.FAILED_RETRYABLE);

    // Advance virtual clock past the 30.5s cooldown and execute all 3 chunks to completion
    harness.advanceClockMs(ACCOUNT_COOLDOWN_MS + 1000);
    const fullExecRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${catAJob.id}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { waitForCooldown: true },
    });
    assert.equal(fullExecRes.statusCode, 200);
    const completedCatAJob = fullExecRes.json().job;
    assert.equal(completedCatAJob.status, DisbursementJobStatus.COMPLETED);
    assert.equal(completedCatAJob.completedChunks, 3);
    assert.equal(completedCatAJob.deliveredAmount, "250000000000");
    assert.equal(completedCatAJob.remainingAmount, "0");

    // Verify 30.5s cooldown was enforced between MAIN_TREASURY's 100B chunk and 50B chunk
    assert.ok(
      harness.sleepCallsMs.some((ms) => ms >= 30_000),
      "Expected 30.5s per-account cooldown sleep between consecutive chunks from MAIN_TREASURY"
    );

    // 3.5 Verify Customer Delivery Tracking & Privacy for completed Category A order
    const custTrackRes = await app.inject({
      method: "GET",
      url: `/api/v1/customer/orders/${catAJourney.order.id}`,
      headers: { authorization: `Bearer ${catAJourney.customerToken}` },
    });
    assert.equal(custTrackRes.statusCode, 200);
    const custTrackBody = custTrackRes.json();
    const custDisbRes = await app.inject({
      method: "GET",
      url: `/api/v1/customer/orders/${catAJourney.order.id}/disbursements`,
      headers: { authorization: `Bearer ${catAJourney.customerToken}` },
    });
    assert.equal(custDisbRes.statusCode, 200);
    const custDisbBody = custDisbRes.json();
    const custSerialized = JSON.stringify({ custTrackBody, custDisbBody });

    assert.equal(custTrackBody.order.status, OrderStatus.COMPLETED);
    assert.equal(custTrackBody.order.gameAmountRequested, "250000000000");
    assert.equal(custTrackBody.order.gameAmountDelivered, "250000000000");
    assert.equal(custTrackBody.order.fulfilledAmount, "250000000000");
    assert.equal(custDisbBody.jobs[0].deliveredAmount, "250000000000");
    assert.equal(custDisbBody.jobs[0].remainingAmount, "0");
    assert.equal(custDisbBody.jobs[0].completedChunks, 3);
    assert.equal(custDisbBody.jobs[0].totalChunks, 3);
    // Strict customer privacy assertions
    assert.ok(!custSerialized.includes("bigola2823"));
    assert.ok(!custSerialized.includes("bigola_res1"));
    assert.ok(!custSerialized.includes("MAIN_TREASURY"));
    assert.ok(!custSerialized.includes("RESERVE_1"));
    assert.ok(!custSerialized.includes("Internal Owner Authorization Note"));
    assert.ok(!custSerialized.includes("session_cookie_"));

    // 3.6 Verify Five-Account Simultaneous Split Allocation (all 5 accounts in one order)
    const fiveWayOrder = await harness.createCustomerWithOrderAndVerifyPayment({
      email: "fiveway-buyer@bigola.local",
      fullName: "Five Way Split Buyer",
      referredByPartner: true,
      recipientLagoslifeUsername: "milespete",
      gameAmountRequested: 500_000_000_000n, // 500B (100B from each of the 5 accounts)
      fiatAmountKobo: 5_000_000n,
      reserveAcrossSlots: [
        { slotCode: "MAIN_TREASURY", amount: 100_000_000_000n },
        { slotCode: "RESERVE_1", amount: 100_000_000_000n },
        { slotCode: "RESERVE_2", amount: 100_000_000_000n },
        { slotCode: "RESERVE_3", amount: 100_000_000_000n },
        { slotCode: "RESERVE_4", amount: 100_000_000_000n },
      ],
      verifyPayment: true,
    });

    const fiveWayAuthRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${fiveWayOrder.order.id}/disbursements/authorize`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {
        allocations: [
          { slotCode: "MAIN_TREASURY", amount: "100000000000" },
          { slotCode: "RESERVE_1", amount: "100000000000" },
          { slotCode: "RESERVE_2", amount: "100000000000" },
          { slotCode: "RESERVE_3", amount: "100000000000" },
          { slotCode: "RESERVE_4", amount: "100000000000" },
        ],
      },
    });
    assert.equal(fiveWayAuthRes.statusCode, 201);
    assert.equal(fiveWayAuthRes.json().job.totalChunks, 5);

    harness.advanceClockMs(ACCOUNT_COOLDOWN_MS + 1000);
    const fiveWayExecRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${fiveWayAuthRes.json().job.id}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: { waitForCooldown: true },
    });
    assert.equal(fiveWayExecRes.statusCode, 200);
    assert.equal(fiveWayExecRes.json().job.status, DisbursementJobStatus.COMPLETED);
    assert.equal(fiveWayExecRes.json().job.completedChunks, 5);

    // 3.7 Verify Refund & Commission Clawback Consistency + Post-Refund Disbursement Block
    const refundOrderJourney = await harness.createCustomerWithOrderAndVerifyPayment({
      email: "refund-buyer@bigola.local",
      fullName: "Refund Test Buyer",
      referredByPartner: true,
      recipientLagoslifeUsername: "milespete",
      gameAmountRequested: 100_000_000_000n,
      fiatAmountKobo: 1_000_000n,
      reserveAcrossSlots: [{ slotCode: "RESERVE_3", amount: 100_000_000_000n }],
      verifyPayment: true,
    });

    // Authorize a job first, then process a full refund before executing the job
    const preRefundJobRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${refundOrderJourney.order.id}/disbursements/authorize`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {
        allocations: [{ slotCode: "RESERVE_3", amount: "100000000000" }],
      },
    });
    assert.equal(preRefundJobRes.statusCode, 201);
    const preRefundJobId = preRefundJobRes.json().job.id;

    const reqRefund = await harness.operationsService.requestRefund({
      orderId: refundOrderJourney.order.id,
      actorUserId: harness.ownerId,
      scope: RefundScope.FULL,
      requestedAmountKobo: 1_000_000n,
      reason: "Customer requested cancellation and full refund prior to delivery",
    });

    const confRefund = await harness.operationsService.confirmRefund({
      orderId: refundOrderJourney.order.id,
      refundId: reqRefund.request.id,
      actorUserId: harness.ownerId,
      confirmedAmountKobo: 1_000_000n,
      refundReference: "REF-BANK-8D-001",
      idempotencyKey: "idem-refund-8d-001",
      reason: "Confirmed bank transfer refund to customer",
    });
    assert.equal(confRefund.order?.status, OrderStatus.REFUNDED);
    assert.equal(confRefund.order?.refundFinancialStatus, RefundFinancialStatus.FULLY_REFUNDED);

    // Verify Category A commission clawback ledger entry was created (-500,000 kobo partner, -500,000 kobo owner)
    const clawbackEntries = harness.commissionLedgerEntries.filter(
      (e) =>
        e.commissionRecordId === refundOrderJourney.commissionRecord?.id &&
        e.entryType === CommissionLedgerEntryType.REVERSAL
    );
    assert.equal(clawbackEntries.length, 1);
    assert.equal(clawbackEntries[0].partnerDeltaKobo, -500_000n);
    assert.equal(clawbackEntries[0].ownerDeltaKobo, -500_000n);

    // Verify executing the pre-existing disbursement job on a REFUNDED order is blocked with 409
    const execAfterRefundRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/disbursements/${preRefundJobId}/execute`,
      headers: { authorization: `Bearer ${harness.ownerToken}` },
      payload: {},
    });
    assert.equal(execAfterRefundRes.statusCode, 409);
    assert.equal(execAfterRefundRes.json().code, "ORDER_NOT_ELIGIBLE_FOR_EXECUTION");

    // =========================================================================
    // 4. SECURITY & RBAC AUDIT
    // =========================================================================
    // 4.1 Owner without 2FA verified is blocked from Owner endpoints
    const no2faRes = await app.inject({
      method: "GET",
      url: "/api/v1/owner/inventory",
      headers: { authorization: `Bearer ${harness.ownerNo2faToken}` },
    });
    assert.equal(no2faRes.statusCode, 403);
    assert.equal(no2faRes.json().code, "MFA_REQUIRED");

    // 4.2 Partner is blocked from Owner inventory and disbursement endpoints
    const partnerInvRes = await app.inject({
      method: "GET",
      url: "/api/v1/owner/inventory",
      headers: { authorization: `Bearer ${harness.partnerToken}` },
    });
    assert.equal(partnerInvRes.statusCode, 403);

    const partnerDisbRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${catBJourney.order.id}/disbursements/authorize`,
      headers: { authorization: `Bearer ${harness.partnerToken}` },
      payload: {
        allocations: [{ slotCode: "RESERVE_2", amount: "100000000000" }],
      },
    });
    assert.equal(partnerDisbRes.statusCode, 403);

    // 4.3 Customer is blocked from Owner and Partner endpoints
    const custOwnerRes = await app.inject({
      method: "GET",
      url: "/api/v1/owner/inventory",
      headers: { authorization: `Bearer ${catAJourney.customerToken}` },
    });
    assert.equal(custOwnerRes.statusCode, 403);

    // 4.4 Audit log secret-hygiene verification
    const serializedAuditLogs = JSON.stringify(harness.auditLogs);
    assert.ok(!serializedAuditLogs.includes("ValidPass123!"));
    assert.ok(!serializedAuditLogs.includes("session_cookie_"));
    assert.ok(
      harness.auditLogs.some((a) => a.actionType === "LAGOSLIFE_ACCOUNT_CONNECTED"),
      "Expected LAGOSLIFE_ACCOUNT_CONNECTED in audit logs"
    );
    assert.ok(
      harness.auditLogs.some((a) => a.actionType === "DISBURSEMENT_JOB_AUTHORIZED"),
      "Expected DISBURSEMENT_JOB_AUTHORIZED in audit logs"
    );
    assert.ok(
      harness.auditLogs.some((a) => a.actionType === "DISBURSEMENT_CHUNK_CONFIRMED"),
      "Expected DISBURSEMENT_CHUNK_CONFIRMED in audit logs"
    );
    assert.ok(
      harness.auditLogs.some((a) => a.actionType === "ORDER_REFUND_CONFIRMED"),
      "Expected ORDER_REFUND_CONFIRMED in audit logs"
    );

    // 4.5 Verify default production safety: DISBURSEMENT_ENABLED defaults to false
    const defaultEnv = loadEnv({ NODE_ENV: "test" });
    assert.equal(defaultEnv.DISBURSEMENT_ENABLED, false);
  } finally {
    if (app) {
      await app.close().catch(() => undefined);
    }
    if (queues) {
      await queues.close().catch(() => undefined);
    }
  }
});
