import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  GameAccountHealth,
  GameAccountRole,
  InventoryDiscrepancyStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { UserRole } from "@bigola/shared";
import { loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";
import type { AuditLogEntryInput, AuditLogRecord, AuditLogStore } from "./lib/audit.js";
import { createQueueInfrastructure, type QueueInfrastructure } from "./lib/redis.js";
import type { AuthStore, AuthUserRecord, PlatformStore, SessionRecord } from "./lib/repositories.js";
import { InventoryService } from "./services/inventory.js";
import {
  encryptSensitiveValue,
  generateTotpCode,
  hashPassword,
} from "./lib/crypto.js";
import {
  LagosLifeAdapter,
  decodeEncryptedSessionBundle,
  mergeCookies,
} from "./services/lagoslife.js";

function makeJsonResponse(
  status: number,
  body: unknown,
  setCookies: string[] = []
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of setCookies) {
    headers.append("set-cookie", c);
  }
  const res = new Response(JSON.stringify(body), { status, headers });
  if (setCookies.length > 0) {
    Object.defineProperty(headers, "getSetCookie", {
      value: () => setCookies,
    });
  }
  return res;
}

function makeSessionCookie(uid: string, username: string, token = "tok123"): string {
  const payload = Buffer.from(JSON.stringify({ uid, u: username, t: token }), "utf8").toString(
    "base64url"
  );
  return `ll_session=${payload}.sig_${username}`;
}

interface InMemoryGameAccountRow {
  id: string;
  slotCode: string;
  lagoslifeUsername: string | null;
  accountRole: GameAccountRole;
  targetReserveAmount: Prisma.Decimal;
  logicalAllocationAmount: Prisma.Decimal;
  lastKnownBalance: Prisma.Decimal;
  reservedForOrders: Prisma.Decimal;
  lastSyncedAt: Date | null;
  healthStatus: GameAccountHealth;
  encryptedSessionBundle: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function createIsolatedStage8AHarness() {
  const users = new Map<string, AuthUserRecord>();
  const sessions = new Map<string, SessionRecord>();
  const auditLogs: Array<Record<string, unknown>> = [];
  const discrepancies: Array<Record<string, unknown>> = [];
  const ledgerEntries: Array<{
    id: string;
    gameAccountId: string;
    orderId: string | null;
    entryType: string;
    deltaAmount: Prisma.Decimal;
    balanceAfter: Prisma.Decimal;
    createdById: string | null;
    notes: string | null;
    createdAt: Date;
  }> = [];

  const reserveTarget = new Prisma.Decimal("70000000000000");
  const zeroDec = new Prisma.Decimal("0");
  const now = new Date();

  const gameAccounts = new Map<string, InMemoryGameAccountRow>([
    [
      "MAIN_TREASURY",
      {
        id: crypto.randomUUID(),
        slotCode: "MAIN_TREASURY",
        lagoslifeUsername: "bigola2823",
        accountRole: GameAccountRole.PRIMARY_TREASURY,
        targetReserveAmount: zeroDec,
        logicalAllocationAmount: zeroDec,
        lastKnownBalance: zeroDec,
        reservedForOrders: zeroDec,
        lastSyncedAt: null,
        healthStatus: GameAccountHealth.UNCONFIGURED,
        encryptedSessionBundle: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    [
      "RESERVE_1",
      {
        id: crypto.randomUUID(),
        slotCode: "RESERVE_1",
        lagoslifeUsername: null,
        accountRole: GameAccountRole.RESERVE,
        targetReserveAmount: reserveTarget,
        logicalAllocationAmount: reserveTarget,
        lastKnownBalance: zeroDec,
        reservedForOrders: zeroDec,
        lastSyncedAt: null,
        healthStatus: GameAccountHealth.UNCONFIGURED,
        encryptedSessionBundle: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    [
      "RESERVE_2",
      {
        id: crypto.randomUUID(),
        slotCode: "RESERVE_2",
        lagoslifeUsername: null,
        accountRole: GameAccountRole.RESERVE,
        targetReserveAmount: reserveTarget,
        logicalAllocationAmount: reserveTarget,
        lastKnownBalance: zeroDec,
        reservedForOrders: zeroDec,
        lastSyncedAt: null,
        healthStatus: GameAccountHealth.UNCONFIGURED,
        encryptedSessionBundle: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    [
      "RESERVE_3",
      {
        id: crypto.randomUUID(),
        slotCode: "RESERVE_3",
        lagoslifeUsername: null,
        accountRole: GameAccountRole.RESERVE,
        targetReserveAmount: reserveTarget,
        logicalAllocationAmount: reserveTarget,
        lastKnownBalance: zeroDec,
        reservedForOrders: zeroDec,
        lastSyncedAt: null,
        healthStatus: GameAccountHealth.UNCONFIGURED,
        encryptedSessionBundle: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    [
      "RESERVE_4",
      {
        id: crypto.randomUUID(),
        slotCode: "RESERVE_4",
        lagoslifeUsername: null,
        accountRole: GameAccountRole.RESERVE,
        targetReserveAmount: reserveTarget,
        logicalAllocationAmount: reserveTarget,
        lastKnownBalance: zeroDec,
        reservedForOrders: zeroDec,
        lastSyncedAt: null,
        healthStatus: GameAccountHealth.UNCONFIGURED,
        encryptedSessionBundle: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
  ]);

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
    async createUser(data) {
      const user: AuthUserRecord = {
        id: crypto.randomUUID(),
        email: data.email.toLowerCase(),
        phone: data.phone ?? null,
        passwordHash: data.passwordHash,
        role: data.role,
        mfaEnabled: false,
        encryptedTotpSecret: null,
        recoveryCodeHashes: null,
        isActive: true,
      };
      users.set(user.id, user);
      return user;
    },
    async updateUserMfa(userId, data) {
      const user = users.get(userId);
      if (user) {
        user.encryptedTotpSecret = data.encryptedTotpSecret;
        user.mfaEnabled = data.mfaEnabled;
        if (data.recoveryCodeHashes !== undefined) {
          user.recoveryCodeHashes = data.recoveryCodeHashes;
        }
      }
    },
    async createSession(data) {
      const session: SessionRecord = {
        id: crypto.randomUUID(),
        ...data,
        revokedAt: null,
      };
      sessions.set(session.id, session);
      return session;
    },
    async findSessionByTokenHash(tokenHash) {
      for (const s of sessions.values()) {
        if (s.tokenHash === tokenHash) {
          const user = users.get(s.userId);
          if (!user) return null;
          return { ...s, user };
        }
      }
      return null;
    },
    async markSessionMfaVerified(sessionId) {
      const s = sessions.get(sessionId);
      if (s) s.mfaVerified = true;
    },
    async revokeSession(sessionId) {
      const s = sessions.get(sessionId);
      if (s) s.revokedAt = new Date();
    },
  };

  const auditStore: AuditLogStore = {
    async create(entry: AuditLogEntryInput): Promise<AuditLogRecord> {
      const record: AuditLogRecord = {
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
      auditLogs.push(record as unknown as Record<string, unknown>);
      return record;
    },
    async listRecent(limit = 50) {
      return (auditLogs as unknown as AuditLogRecord[]).slice(-limit).reverse();
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

  const prismaDouble = {
    gameAccount: {
      async findMany() {
        return Array.from(gameAccounts.values()).sort((a, b) =>
          a.slotCode.localeCompare(b.slotCode)
        );
      },
      async findUnique({ where }: { where: { slotCode?: string; id?: string } }) {
        if (where.slotCode) return gameAccounts.get(where.slotCode) ?? null;
        if (where.id) {
          for (const acc of gameAccounts.values()) {
            if (acc.id === where.id) return acc;
          }
        }
        return null;
      },
      async findFirst({
        where,
      }: {
        where: {
          lagoslifeUsername?: { equals: string; mode?: string };
          NOT?: { id: string };
        };
      }) {
        const target = where.lagoslifeUsername?.equals?.toLowerCase();
        if (!target) return null;
        for (const acc of gameAccounts.values()) {
          if (where.NOT?.id && acc.id === where.NOT.id) continue;
          if (acc.lagoslifeUsername && acc.lagoslifeUsername.toLowerCase() === target) {
            return { slotCode: acc.slotCode };
          }
        }
        return null;
      },
      async update({
        where,
        data,
      }: {
        where: { id?: string; slotCode?: string };
        data: Record<string, unknown>;
      }) {
        let row: InMemoryGameAccountRow | undefined;
        if (where.slotCode) {
          row = gameAccounts.get(where.slotCode);
        } else if (where.id) {
          for (const acc of gameAccounts.values()) {
            if (acc.id === where.id) {
              row = acc;
              break;
            }
          }
        }
        if (!row) throw new Error("GameAccount not found in test double");
        if (typeof data.lastKnownBalance === "string") {
          row.lastKnownBalance = new Prisma.Decimal(data.lastKnownBalance);
        }
        if (typeof data.healthStatus === "string") {
          row.healthStatus = data.healthStatus as GameAccountHealth;
        }
        if (data.lastSyncedAt instanceof Date) {
          row.lastSyncedAt = data.lastSyncedAt;
        }
        if (data.lagoslifeUsername !== undefined) {
          row.lagoslifeUsername = data.lagoslifeUsername as string | null;
        }
        if (data.encryptedSessionBundle !== undefined) {
          row.encryptedSessionBundle = data.encryptedSessionBundle as string | null;
        }
        row.updatedAt = new Date();
        return { ...row };
      },
    },
    platformSetting: {
      async findUnique() {
        return null;
      },
    },
    inventoryLedger: {
      async findMany({
        where,
      }: {
        where?: { gameAccountId?: string; entryType?: string };
      } = {}) {
        if (where?.gameAccountId) {
          return ledgerEntries.filter(
            (e) =>
              e.gameAccountId === where.gameAccountId &&
              (!where.entryType || e.entryType === where.entryType)
          );
        }
        return ledgerEntries.slice(-25).map((e) => {
          let slotCode = "MAIN_TREASURY";
          for (const acc of gameAccounts.values()) {
            if (acc.id === e.gameAccountId) slotCode = acc.slotCode;
          }
          return {
            ...e,
            gameAccount: { slotCode },
          };
        });
      },
      async create({ data }: { data: Record<string, unknown> }) {
        const entry = {
          id: crypto.randomUUID(),
          gameAccountId: String(data.gameAccountId),
          orderId: (data.orderId as string | null) ?? null,
          entryType: String(data.entryType),
          deltaAmount: new Prisma.Decimal(String(data.deltaAmount)),
          balanceAfter: new Prisma.Decimal(String(data.balanceAfter)),
          createdById: (data.createdById as string | null) ?? null,
          notes: (data.notes as string | null) ?? null,
          createdAt: new Date(),
        };
        ledgerEntries.push(entry);
        return entry;
      },
    },
    inventoryDiscrepancy: {
      async count() {
        return discrepancies.filter((d) => d.status === InventoryDiscrepancyStatus.OPEN).length;
      },
      async create({ data }: { data: Record<string, unknown> }) {
        const disc = {
          id: crypto.randomUUID(),
          ...data,
          createdAt: new Date(),
        };
        discrepancies.push(disc);
        return disc;
      },
      async findMany() {
        return discrepancies;
      },
    },
    user: {
      async findMany() {
        return Array.from(users.values()).map((u) => ({ id: u.id }));
      },
    },
    notification: {
      async createMany() {
        return { count: 0 };
      },
    },
    auditLog: {
      async create({ data }: { data: Record<string, unknown> }) {
        const rec = { id: crypto.randomUUID(), ...data, createdAt: new Date() };
        auditLogs.push(rec);
        return rec;
      },
    },
    async $queryRaw(_strings: TemplateStringsArray, slotCodeArg: unknown) {
      const slotCode = String(slotCodeArg);
      const row = gameAccounts.get(slotCode);
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
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(prismaDouble);
    },
  } as unknown as PrismaClient;

  return {
    users,
    gameAccounts,
    auditLogs,
    discrepancies,
    ledgerEntries,
    authStore,
    auditStore,
    platformStore,
    prismaDouble,
  };
}

describe("Stage 8A: LagosLife Authentication & Five-Account Session Management", () => {
  it("verifies LagosLifeAdapter cookie merging, login, 2FA, cookie import, identity check, and recipient resolution", async () => {
    const c1 = "ll_session=old_val; cf_clearance=abc";
    const c2 = ["ll_session=new_val; Path=/; HttpOnly", "theme=dark; Path=/"];
    const merged = mergeCookies(c1, c2);
    assert.ok(merged.includes("ll_session=new_val"));
    assert.ok(merged.includes("cf_clearance=abc"));
    assert.ok(merged.includes("theme=dark"));

    const adapter = new LagosLifeAdapter({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const cookie = new Headers(init?.headers).get("cookie") || "";

        if (url.endsWith("/api/auth/login")) {
          const body = JSON.parse(String(init?.body || "{}"));
          if (body.password === "wrong-pass") {
            return makeJsonResponse(401, { error: "Invalid credentials" });
          }
          if (body.username === "reserve_2fa") {
            return makeJsonResponse(
              200,
              {
                code: "two_factor",
                challenge: "chal_tok_2fa_99",
                method: "email",
                to: "r***@example.com",
              },
              ["pre_2fa=1; Path=/; HttpOnly"]
            );
          }
          const sess = makeSessionCookie("6e3c4bdaac6f4765ba52", body.username);
          return makeJsonResponse(
            200,
            { ok: true, user: { id: "6e3c4bdaac6f4765ba52", username: body.username } },
            [`${sess}; Path=/; HttpOnly`]
          );
        }

        if (url.endsWith("/api/auth/2fa")) {
          const body = JSON.parse(String(init?.body || "{}"));
          if (body.action === "send") {
            return makeJsonResponse(200, { ok: true, to: "r***@example.com" });
          }
          if (body.action === "login" && body.code === "654321") {
            const sess = makeSessionCookie("uid_r2fa", "reserve_2fa");
            return makeJsonResponse(200, { ok: true }, [`${sess}; Path=/; HttpOnly`]);
          }
          return makeJsonResponse(400, { error: "Invalid 2FA code" });
        }

        if (url.endsWith("/api/auth/me")) {
          if (cookie.includes("sig_bigola2823")) {
            return makeJsonResponse(200, {
              user: { id: "6e3c4bdaac6f4765ba52", username: "bigola2823", name: "Big Ola Main" },
            });
          }
          if (cookie.includes("sig_reserve_2fa")) {
            return makeJsonResponse(200, {
              user: { id: "uid_r2fa", username: "reserve_2fa", name: "Reserve One Sim" },
            });
          }
          return makeJsonResponse(401, { error: "Unauthorized" });
        }

        if (url.endsWith("/api/save")) {
          if (cookie.includes("sig_bigola2823")) {
            return makeJsonResponse(200, {
              game: {
                money: 125_000_000_000_000,
                sim: { name: "Big Ola Main" },
                owner: "6e3c4bdaac6f4765ba52",
              },
              players: [
                { id: "player_uid_777", username: "BuyerKing", name: "King Buyer" },
              ],
            });
          }
          if (cookie.includes("sig_reserve_2fa")) {
            return makeJsonResponse(200, {
              game: {
                money: 70_000_000_000_000,
                sim: { name: "Reserve One Sim" },
                owner: "uid_r2fa",
              },
            });
          }
          return makeJsonResponse(401, { error: "Unauthorized" });
        }

        if (url.includes("/api/players?q=")) {
          return makeJsonResponse(200, {
            players: [{ id: "player_uid_777", username: "BuyerKing", name: "King Buyer" }],
          });
        }

        return makeJsonResponse(404, { error: "Not found" });
      },
    });

    // 1. Direct login success
    const directRes = await adapter.loginWithCredentials({
      slotCode: "MAIN_TREASURY",
      username: "bigola2823",
      password: "correct-pass",
    });
    assert.equal(directRes.status, "AUTHENTICATED");
    if (directRes.status === "AUTHENTICATED") {
      assert.equal(directRes.identity.username, "bigola2823");
      assert.equal(directRes.accountData.money, 125_000_000_000_000n);
    }

    // 2. Failed login handling
    await assert.rejects(
      () =>
        adapter.loginWithCredentials({
          slotCode: "MAIN_TREASURY",
          username: "bigola2823",
          password: "wrong-pass",
        }),
      (err: unknown) => (err as { code?: string }).code === "LAGOSLIFE_LOGIN_REJECTED"
    );

    // 3. Login 2FA challenge + resend + completion
    const challengeRes = await adapter.loginWithCredentials({
      slotCode: "RESERVE_1",
      username: "reserve_2fa",
      password: "correct-pass",
    });
    assert.equal(challengeRes.status, "TWO_FACTOR_REQUIRED");
    if (challengeRes.status === "TWO_FACTOR_REQUIRED") {
      const resent = await adapter.resendLoginTwoFactor(challengeRes.challenge);
      assert.equal(resent.ok, true);
      const completed2fa = await adapter.completeLoginTwoFactor({
        slotCode: "RESERVE_1",
        challenge: challengeRes.challenge,
        code: "654321",
      });
      assert.equal(completed2fa.identity.username, "reserve_2fa");
      assert.equal(completed2fa.accountData.money, 70_000_000_000_000n);
    }

    // 4. Exact recipient username resolution (known directory + live /api/players)
    const resolvedKnown = await adapter.resolveTargetIdAsync("bigola2823");
    assert.equal(resolvedKnown?.id, "6e3c4bdaac6f4765ba52");
    assert.equal(resolvedKnown?.username, "bigola2823");

    const resolvedOnline = await adapter.resolveTargetIdAsync("@BuyerKing");
    assert.equal(resolvedOnline?.id, "player_uid_777");
    assert.equal(resolvedOnline?.username, "BuyerKing");
  });

  it("verifies full 5-account Arrangement A workflow, AES-256-GCM encryption, zero secret leakage, mismatch rejection, expired session handling, and discrepancy preservation in isolated memory", async () => {
    let app: Awaited<ReturnType<typeof buildApp>> | null = null;
    let queues: QueueInfrastructure | null = null;

    try {
      const env = loadEnv({
        NODE_ENV: "test",
        SESSION_SECRET: "test_only_session_secret_at_least_32_characters_long",
        ENCRYPTION_KEY_HEX: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        OWNER_REQUIRE_2FA: "true",
        DISBURSEMENT_ENABLED: "false",
      });

      const harness = createIsolatedStage8AHarness();
      queues = createQueueInfrastructure(undefined);

      const simulatedBalances: Record<string, bigint> = {
        bigola2823: 150_000_000_000_000n,
        ola_reserve_1: 70_000_000_000_000n,
        ola_reserve_2: 70_000_000_000_000n,
        ola_reserve_3: 70_000_000_000_000n,
        ola_reserve_4: 70_000_000_000_000n,
      };
      const expiredUsers = new Set<string>();

      const mockAdapter = new LagosLifeAdapter({
        fetchImpl: async (input, init) => {
          const url = String(input);
          const cookie = new Headers(init?.headers).get("cookie") || "";

          if (url.endsWith("/api/auth/login")) {
            const body = JSON.parse(String(init?.body || "{}"));
            if (body.password === "bad-password") {
              return makeJsonResponse(401, { error: "Invalid username or password" });
            }
            if (body.username === "ola_reserve_1" && body.password === "trigger-2fa") {
              return makeJsonResponse(
                200,
                {
                  code: "two_factor",
                  challenge: "act_r1_token",
                  method: "email",
                  to: "r1***@bigola.test",
                },
                ["ll_pre2fa=1; Path=/; HttpOnly"]
              );
            }
            const uid =
              body.username === "bigola2823"
                ? "6e3c4bdaac6f4765ba52"
                : `uid_${body.username}`;
            const sess = makeSessionCookie(uid, body.username, `secret_tok_${body.username}`);
            return makeJsonResponse(
              200,
              { ok: true, user: { id: uid, username: body.username } },
              [`${sess}; Path=/; HttpOnly`]
            );
          }

          if (url.endsWith("/api/auth/2fa")) {
            const body = JSON.parse(String(init?.body || "{}"));
            if (body.action === "send") {
              return makeJsonResponse(200, { ok: true, to: "r1***@bigola.test" });
            }
            if (body.action === "login" && body.code === "112233") {
              const sess = makeSessionCookie(
                "uid_ola_reserve_1",
                "ola_reserve_1",
                "secret_tok_ola_reserve_1"
              );
              return makeJsonResponse(200, { ok: true }, [`${sess}; Path=/; HttpOnly`]);
            }
            return makeJsonResponse(400, { error: "Invalid 2FA verification code" });
          }

          const match = /sig_([A-Za-z0-9_]+)/.exec(cookie);
          const cookieUser = match?.[1] ?? null;

          if (url.endsWith("/api/auth/me")) {
            if (!cookieUser || expiredUsers.has(cookieUser)) {
              return makeJsonResponse(401, { error: "Session expired" });
            }
            const uid =
              cookieUser === "bigola2823" ? "6e3c4bdaac6f4765ba52" : `uid_${cookieUser}`;
            return makeJsonResponse(200, {
              user: { id: uid, username: cookieUser, name: `Sim ${cookieUser}` },
            });
          }

          if (url.endsWith("/api/save")) {
            if (!cookieUser || expiredUsers.has(cookieUser)) {
              return makeJsonResponse(401, { error: "Session expired" });
            }
            const bal = Number(simulatedBalances[cookieUser] ?? 70_000_000_000_000n);
            return makeJsonResponse(200, {
              game: {
                money: bal,
                sim: { name: `Sim ${cookieUser}` },
                owner:
                  cookieUser === "bigola2823" ? "6e3c4bdaac6f4765ba52" : `uid_${cookieUser}`,
              },
              players: [
                { id: "uid_target_customer", username: "lagos_vip", name: "Lagos VIP" },
              ],
            });
          }

          if (url.includes("/api/players?q=")) {
            return makeJsonResponse(200, {
              players: [{ id: "uid_target_customer", username: "lagos_vip", name: "Lagos VIP" }],
            });
          }

          return makeJsonResponse(404, { error: "Not found" });
        },
      });

      const inventoryService = new InventoryService(harness.prismaDouble, {
        encryptionKeyHex: env.ENCRYPTION_KEY_HEX,
        lagosLifeAdapter: mockAdapter,
      });

      app = await buildApp({
        env,
        authStore: harness.authStore,
        auditStore: harness.auditStore,
        platformStore: harness.platformStore,
        queues,
        checkDb: async () => true,
        prisma: harness.prismaDouble,
        inventoryService,
      });

      // Create isolated in-memory Owner user with 2FA
      const totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
      const ownerUser = await harness.authStore.createUser({
        email: "owner-stage8a@bigola.test",
        passwordHash: await hashPassword("OwnerStrongPass123!"),
        role: UserRole.OWNER,
      });
      await harness.authStore.updateUserMfa(ownerUser.id, {
        encryptedTotpSecret: encryptSensitiveValue(totpSecret, env.ENCRYPTION_KEY_HEX),
        mfaEnabled: true,
      });

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          email: ownerUser.email,
          password: "OwnerStrongPass123!",
        },
      });
      assert.equal(loginRes.statusCode, 200);
      const ownerToken = loginRes.json().token as string;
      const ownerAuthHeaders = { authorization: `Bearer ${ownerToken}` };

      const verifyMfaRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/2fa/verify",
        headers: ownerAuthHeaders,
        payload: { code: generateTotpCode(totpSecret) },
      });
      assert.equal(verifyMfaRes.statusCode, 200);

      // 1. Connect MAIN_TREASURY (@bigola2823) via credentials
      const connectMainRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/accounts/MAIN_TREASURY/connect/login",
        headers: ownerAuthHeaders,
        payload: {
          username: "bigola2823",
          password: "SuperSecretPassword_DO_NOT_LEAK",
        },
      });
      assert.equal(connectMainRes.statusCode, 200);
      const connectMainBody = connectMainRes.json();
      assert.equal(connectMainBody.status, "CONNECTED");
      assert.equal(connectMainBody.lagoslifeUsername, "bigola2823");
      assert.equal(connectMainBody.observedBalance, "150000000000000");

      // 2. Reject wrong username on MAIN_TREASURY (Slot/Username mismatch rejection)
      const mismatchMainRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/accounts/MAIN_TREASURY/connect/login",
        headers: ownerAuthHeaders,
        payload: {
          username: "ola_reserve_1",
          password: "any-password",
        },
      });
      assert.equal(mismatchMainRes.statusCode, 409);
      assert.equal(mismatchMainRes.json().code, "SLOT_IDENTITY_MISMATCH");

      // 3. Reject duplicate username across different slots (connecting bigola2823 to RESERVE_1)
      const dupSlotRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/accounts/RESERVE_1/connect/login",
        headers: ownerAuthHeaders,
        payload: {
          username: "bigola2823",
          password: "any-password",
        },
      });
      assert.equal(dupSlotRes.statusCode, 409);
      assert.equal(dupSlotRes.json().code, "DUPLICATE_LAGOSLIFE_USERNAME");

      // 4. Failed login handling on RESERVE_1
      const failedLoginRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/accounts/RESERVE_1/connect/login",
        headers: ownerAuthHeaders,
        payload: {
          username: "ola_reserve_1",
          password: "bad-password",
        },
      });
      assert.equal(failedLoginRes.statusCode, 401);
      assert.equal(failedLoginRes.json().code, "LAGOSLIFE_LOGIN_REJECTED");

      // 5. Connect RESERVE_1 via 2FA challenge + resend + completion
      const r1ChallengeRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/accounts/RESERVE_1/connect/login",
        headers: ownerAuthHeaders,
        payload: {
          username: "ola_reserve_1",
          password: "trigger-2fa",
        },
      });
      assert.equal(r1ChallengeRes.statusCode, 200);
      const r1ChallengeBody = r1ChallengeRes.json();
      assert.equal(r1ChallengeBody.status, "TWO_FACTOR_REQUIRED");
      assert.equal(r1ChallengeBody.challenge, "act_r1_token");

      const r1ResendRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/accounts/RESERVE_1/connect/2fa/resend",
        headers: ownerAuthHeaders,
        payload: { challenge: r1ChallengeBody.challenge },
      });
      assert.equal(r1ResendRes.statusCode, 200);
      assert.equal(r1ResendRes.json().ok, true);

      const r1Complete2faRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/accounts/RESERVE_1/connect/2fa",
        headers: ownerAuthHeaders,
        payload: {
          challenge: r1ChallengeBody.challenge,
          code: "112233",
        },
      });
      assert.equal(r1Complete2faRes.statusCode, 200);
      assert.equal(r1Complete2faRes.json().status, "CONNECTED");
      assert.equal(r1Complete2faRes.json().lagoslifeUsername, "ola_reserve_1");
      assert.equal(r1Complete2faRes.json().observedBalance, "70000000000000");

      // 6. Connect RESERVE_2 via Session Cookie Import
      const r2Cookie = makeSessionCookie(
        "uid_ola_reserve_2",
        "ola_reserve_2",
        "secret_tok_ola_reserve_2"
      );
      const r2ImportRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/accounts/RESERVE_2/connect/cookie",
        headers: ownerAuthHeaders,
        payload: {
          cookie: r2Cookie,
          lagoslifeUsername: "ola_reserve_2",
        },
      });
      assert.equal(r2ImportRes.statusCode, 200);
      assert.equal(r2ImportRes.json().status, "CONNECTED");
      assert.equal(r2ImportRes.json().lagoslifeUsername, "ola_reserve_2");

      // 7. Connect RESERVE_3 and RESERVE_4 via credentials so all 5 slots are independently connected
      for (const [slotCode, uname] of [
        ["RESERVE_3", "ola_reserve_3"],
        ["RESERVE_4", "ola_reserve_4"],
      ] as const) {
        const res = await app.inject({
          method: "POST",
          url: `/api/v1/owner/inventory/accounts/${slotCode}/connect/login`,
          headers: ownerAuthHeaders,
          payload: { username: uname, password: "valid-password" },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().status, "CONNECTED");
      }

      // 8. Verify AES-256-GCM encryption at rest & zero secret leakage in API/audit logs
      const dbMain = harness.gameAccounts.get("MAIN_TREASURY")!;
      assert.ok(dbMain.encryptedSessionBundle, "Session bundle must be stored encrypted");
      assert.ok(
        !dbMain.encryptedSessionBundle.includes("ll_session="),
        "Encrypted column must not contain plaintext cookie"
      );
      assert.ok(
        !dbMain.encryptedSessionBundle.includes("secret_tok_bigola2823"),
        "Encrypted column must not contain raw token"
      );
      const decodedMain = decodeEncryptedSessionBundle(
        dbMain.encryptedSessionBundle,
        env.ENCRYPTION_KEY_HEX
      );
      assert.equal(decodedMain?.username, "bigola2823");
      assert.ok(decodedMain?.cookie.includes("ll_session="));

      const overviewRes = await app.inject({
        method: "GET",
        url: "/api/v1/owner/inventory",
        headers: ownerAuthHeaders,
      });
      assert.equal(overviewRes.statusCode, 200);
      const overviewRaw = overviewRes.body;
      assert.ok(!overviewRaw.includes("ll_session="));
      assert.ok(!overviewRaw.includes("secret_tok_"));
      assert.ok(!overviewRaw.includes("SuperSecretPassword_DO_NOT_LEAK"));
      assert.ok(!overviewRaw.includes("encryptedSessionBundle"));

      const overviewJson = overviewRes.json();
      assert.equal(overviewJson.slots.length, 5);
      for (const acc of overviewJson.slots) {
        assert.equal(acc.connectionStatus, "CONNECTED");
        assert.equal(acc.sessionConnected, true);
        assert.equal(
          acc.eligibleForFulfilment,
          true,
          `Slot ${acc.slotCode} must be eligible for fulfilment under Arrangement A`
        );
      }

      const serializedAudits = JSON.stringify(harness.auditLogs);
      assert.ok(!serializedAudits.includes("ll_session="));
      assert.ok(!serializedAudits.includes("secret_tok_"));
      assert.ok(!serializedAudits.includes("SuperSecretPassword_DO_NOT_LEAK"));

      // 9. Verify connected session endpoint (/verify-session)
      const verifyMainRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/accounts/MAIN_TREASURY/verify-session",
        headers: ownerAuthHeaders,
        payload: {},
      });
      assert.equal(verifyMainRes.statusCode, 200);
      assert.equal(verifyMainRes.json().valid, true);
      assert.equal(verifyMainRes.json().connectionStatus, "CONNECTED");

      // 10. Live balance synchronization & discrepancy preservation when live balance changes unexpectedly
      simulatedBalances.ola_reserve_2 = 68_500_000_000_000n; // Unexpected 1.5T drop
      const syncR2Res = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/accounts/RESERVE_2/sync-live",
        headers: ownerAuthHeaders,
        payload: {},
      });
      assert.equal(syncR2Res.statusCode, 200);
      const syncR2Body = syncR2Res.json();
      assert.equal(syncR2Body.observedBalance, "68500000000000");
      assert.ok(
        syncR2Body.discrepancy?.id,
        "Unexpected balance change during live sync must create an InventoryDiscrepancy record"
      );

      // 11. Expired session detection on RESERVE_3 during verify-session and sync-all-live
      expiredUsers.add("ola_reserve_3");
      const verifyR3Res = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/accounts/RESERVE_3/verify-session",
        headers: ownerAuthHeaders,
        payload: {},
      });
      assert.equal(verifyR3Res.statusCode, 200);
      assert.equal(verifyR3Res.json().valid, false);
      assert.equal(verifyR3Res.json().connectionStatus, "SESSION_EXPIRED");

      const syncAllRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/sync-all-live",
        headers: ownerAuthHeaders,
        payload: {},
      });
      assert.equal(syncAllRes.statusCode, 200);
      const syncAllBody = syncAllRes.json();
      const syncedCount = syncAllBody.results.filter(
        (r: { status: string }) => r.status === "SYNCED"
      ).length;
      const expiredCount = syncAllBody.results.filter(
        (r: { status: string }) => r.status === "SESSION_EXPIRED"
      ).length;
      assert.equal(syncedCount, 4);
      assert.equal(expiredCount, 1);

      // 12. Resolve player username via connected session
      const resolveRes = await app.inject({
        method: "GET",
        url: "/api/v1/owner/inventory/resolve-player?q=lagos_vip",
        headers: ownerAuthHeaders,
      });
      assert.equal(resolveRes.statusCode, 200);
      assert.equal(resolveRes.json().id, "uid_target_customer");
      assert.equal(resolveRes.json().username, "lagos_vip");
    } finally {
      if (app) {
        await app.close();
      }
      if (queues) {
        await queues.close();
      }
    }
  });
});
