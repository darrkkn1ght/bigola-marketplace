import { Prisma, PrismaClient } from "@prisma/client";
import type { UserRole } from "@bigola/shared";
import type { AuditLogEntryInput, AuditLogRecord, AuditLogStore } from "./audit.js";

export interface AuthUserRecord {
  id: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  role: UserRole;
  mfaEnabled: boolean;
  encryptedTotpSecret: string | null;
  recoveryCodeHashes: string[] | null;
  isActive: boolean;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  mfaVerified: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface AuthStore {
  findUserByEmail(email: string): Promise<AuthUserRecord | null>;
  findUserById(id: string): Promise<AuthUserRecord | null>;
  createUser(data: {
    email: string;
    phone?: string | null;
    passwordHash: string;
    role: UserRole;
  }): Promise<AuthUserRecord>;
  updateUserMfa(
    userId: string,
    data: { encryptedTotpSecret: string; mfaEnabled: boolean; recoveryCodeHashes?: string[] | null }
  ): Promise<void>;
  createSession(data: Omit<SessionRecord, "id" | "revokedAt">): Promise<SessionRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<(SessionRecord & { user: AuthUserRecord }) | null>;
  markSessionMfaVerified(sessionId: string): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
}

export interface PlatformStore {
  getSettings(): Promise<Array<{ key: string; value: unknown; description: string | null; updatedAt: Date }>>;
  upsertSetting(key: string, value: unknown, updatedBy: string): Promise<{ key: string; value: unknown }>;
  getCommissionRules(): Promise<Array<{
    id: string;
    category: string;
    status: string;
    partnerShareBps: number | null;
    ownerShareBps: number | null;
    notes: string | null;
    effectiveFrom: Date;
  }>>;
  getGameAccounts(): Promise<Array<{
    id: string;
    slotCode: string;
    lagoslifeUsername: string | null;
    accountRole: string;
    targetReserveAmount: string;
    lastKnownBalance: string;
    reservedForOrders: string;
    healthStatus: string;
  }>>;
  findPartnerByUserId(userId: string): Promise<{ id: string; referralCode: string; displayName: string } | null>;
  listPartnerCustomers(partnerId: string): Promise<Array<{ id: string; fullName: string; category: string }>>;
}

export function createPrismaStores(prisma: PrismaClient): {
  authStore: AuthStore;
  auditStore: AuditLogStore;
  platformStore: PlatformStore;
} {
  function mapUser(u: {
    id: string;
    email: string;
    phone: string | null;
    passwordHash: string;
    role: UserRole;
    mfaEnabled: boolean;
    encryptedTotpSecret: string | null;
    recoveryCodeHashes: Prisma.JsonValue | null;
    isActive: boolean;
  }): AuthUserRecord {
    return {
      ...u,
      recoveryCodeHashes: Array.isArray(u.recoveryCodeHashes)
        ? (u.recoveryCodeHashes as string[])
        : null,
    };
  }

  const authStore: AuthStore = {
    async findUserByEmail(email) {
      const u = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      return u ? mapUser(u) : null;
    },
    async findUserById(id) {
      const u = await prisma.user.findUnique({ where: { id } });
      return u ? mapUser(u) : null;
    },
    async createUser(data) {
      const u = await prisma.user.create({
        data: {
          email: data.email.toLowerCase(),
          phone: data.phone ?? null,
          passwordHash: data.passwordHash,
          role: data.role,
        },
      });
      return mapUser(u);
    },
    async updateUserMfa(userId, data) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          encryptedTotpSecret: data.encryptedTotpSecret,
          mfaEnabled: data.mfaEnabled,
          ...(data.recoveryCodeHashes !== undefined
            ? {
                recoveryCodeHashes:
                  data.recoveryCodeHashes === null
                    ? Prisma.JsonNull
                    : (data.recoveryCodeHashes as Prisma.InputJsonValue),
              }
            : {}),
        },
      });
    },
    async createSession(data) {
      return prisma.userSession.create({ data });
    },
    async findSessionByTokenHash(tokenHash) {
      const s = await prisma.userSession.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (!s) return null;
      return { ...s, user: mapUser(s.user) };
    },
    async markSessionMfaVerified(sessionId) {
      await prisma.userSession.update({
        where: { id: sessionId },
        data: { mfaVerified: true },
      });
    },
    async revokeSession(sessionId) {
      await prisma.userSession.update({
        where: { id: sessionId },
        data: { revokedAt: new Date() },
      });
    },
  };

  const auditStore: AuditLogStore = {
    async create(entry: AuditLogEntryInput): Promise<AuditLogRecord> {
      const row = await prisma.auditLog.create({
        data: {
          actorUserId: entry.actorUserId,
          actionType: entry.actionType,
          targetEntity: entry.targetEntity,
          targetId: entry.targetId ?? null,
          beforeState: (entry.beforeState ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          afterState: (entry.afterState ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          reason: entry.reason ?? null,
          ipAddress: entry.ipAddress ?? null,
        },
      });
      return {
        id: row.id,
        actorUserId: row.actorUserId,
        actionType: row.actionType,
        targetEntity: row.targetEntity,
        targetId: row.targetId,
        beforeState: (row.beforeState as Record<string, unknown> | null) ?? null,
        afterState: (row.afterState as Record<string, unknown> | null) ?? null,
        reason: row.reason,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
      };
    },
    async listRecent(limit = 50): Promise<AuditLogRecord[]> {
      const rows = await prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return rows.map((row) => ({
        id: row.id,
        actorUserId: row.actorUserId,
        actionType: row.actionType,
        targetEntity: row.targetEntity,
        targetId: row.targetId,
        beforeState: (row.beforeState as Record<string, unknown> | null) ?? null,
        afterState: (row.afterState as Record<string, unknown> | null) ?? null,
        reason: row.reason,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
      }));
    },
  };

  const platformStore: PlatformStore = {
    async getSettings() {
      return prisma.platformSetting.findMany({ orderBy: { key: "asc" } });
    },
    async upsertSetting(key, value, updatedBy) {
      const row = await prisma.platformSetting.upsert({
        where: { key },
        update: { value: value as Prisma.InputJsonValue, updatedBy },
        create: { key, value: value as Prisma.InputJsonValue, updatedBy },
      });
      return { key: row.key, value: row.value };
    },
    async getCommissionRules() {
      return prisma.commissionRule.findMany({ orderBy: { createdAt: "asc" } });
    },
    async getGameAccounts() {
      const rows = await prisma.gameAccount.findMany({ orderBy: { slotCode: "asc" } });
      return rows.map((r) => ({
        id: r.id,
        slotCode: r.slotCode,
        lagoslifeUsername: r.lagoslifeUsername,
        accountRole: r.accountRole,
        targetReserveAmount: r.targetReserveAmount.toString(),
        lastKnownBalance: r.lastKnownBalance.toString(),
        reservedForOrders: r.reservedForOrders.toString(),
        healthStatus: r.healthStatus,
      }));
    },
    async findPartnerByUserId(userId) {
      return prisma.partner.findUnique({
        where: { userId },
        select: { id: true, referralCode: true, displayName: true },
      });
    },
    async listPartnerCustomers(partnerId) {
      return prisma.customer.findMany({
        where: { attributedPartnerId: partnerId },
        select: { id: true, fullName: true, category: true },
      });
    },
  };

  return { authStore, auditStore, platformStore };
}

