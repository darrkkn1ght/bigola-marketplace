import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { UserRole } from "@bigola/shared";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import type { AuditLogEntryInput, AuditLogRecord, AuditLogStore } from "./lib/audit.js";
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  generateTotpCode,
  generateTotpSecret,
  hashPassword,
  verifyPassword,
  verifyTotpCode,
} from "./lib/crypto.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import type { AuthStore, AuthUserRecord, PlatformStore, SessionRecord } from "./lib/repositories.js";

function createInMemoryStores() {
  const users = new Map<string, AuthUserRecord>();
  const sessions = new Map<string, SessionRecord>();
  const auditLogs: AuditLogRecord[] = [];
  const partnersByUser = new Map<string, { id: string; referralCode: string; displayName: string }>();
  const partnerCustomers = new Map<string, Array<{ id: string; fullName: string; category: string }>>();
  const settings = new Map<string, { key: string; value: unknown; description: string | null; updatedAt: Date }>([
    [
      "bulk_pricing",
      {
        key: "bulk_pricing",
        value: { priceKoboPerTrillion: "100000", minBulkGameAmount: "10000000000000" },
        description: "Bulk pricing",
        updatedAt: new Date(),
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
    async create(entry: AuditLogEntryInput) {
      const rec: AuditLogRecord = {
        id: crypto.randomUUID(),
        ...entry,
        createdAt: new Date(),
      };
      auditLogs.unshift(rec);
      return rec;
    },
    async listRecent(limit = 50) {
      return auditLogs.slice(0, limit);
    },
  };

  const platformStore: PlatformStore = {
    async getSettings() {
      return Array.from(settings.values());
    },
    async upsertSetting(key, value) {
      const rec = { key, value, description: null, updatedAt: new Date() };
      settings.set(key, rec);
      return { key, value };
    },
    async getCommissionRules() {
      return [
        {
          id: crypto.randomUUID(),
          category: "CATEGORY_A_PARTNER",
          status: "ACTIVE",
          partnerShareBps: 5000,
          ownerShareBps: 5000,
          notes: "50/50 gross split",
          effectiveFrom: new Date(),
        },
        {
          id: crypto.randomUUID(),
          category: "CATEGORY_B_BIGOLA",
          status: "PENDING_RULE",
          partnerShareBps: null,
          ownerShareBps: null,
          notes: "Pending agreement",
          effectiveFrom: new Date(),
        },
      ];
    },
    async getGameAccounts() {
      return [
        {
          id: crypto.randomUUID(),
          slotCode: "MAIN_TREASURY",
          lagoslifeUsername: "bigola2823",
          accountRole: "MAIN_TREASURY",
          targetReserveAmount: "0",
          lastKnownBalance: "0",
          reservedForOrders: "0",
          healthStatus: "UNCONFIGURED",
        },
      ];
    },
    async findPartnerByUserId(userId) {
      return partnersByUser.get(userId) ?? null;
    },
    async listPartnerCustomers(partnerId) {
      return partnerCustomers.get(partnerId) ?? [];
    },
  };

  return { users, sessions, partnersByUser, partnerCustomers, authStore, auditStore, platformStore, auditLogs };
}

describe("Crypto & 2FA Foundations", () => {
  it("hashes and verifies passwords with scrypt", async () => {
    const hash = await hashPassword("StrongPass#2026");
    assert.equal(await verifyPassword("StrongPass#2026", hash), true);
    assert.equal(await verifyPassword("WrongPassword", hash), false);
  });

  it("encrypts and decrypts sensitive values with AES-256-GCM", () => {
    const keyHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const encrypted = encryptSensitiveValue("JBSWY3DPEHPK3PXP", keyHex);
    assert.notEqual(encrypted, "JBSWY3DPEHPK3PXP");
    assert.equal(decryptSensitiveValue(encrypted, keyHex), "JBSWY3DPEHPK3PXP");
  });

  it("generates and verifies RFC 6238 TOTP codes", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = generateTotpCode(secret, now);
    assert.equal(verifyTotpCode(secret, code, now), true);
    assert.equal(verifyTotpCode(secret, "000000", now), false);
  });
});

describe("Auth, RBAC, 2FA Enforcement & Audit Logging", () => {
  it("enforces role isolation, Owner 2FA requirement, and audit logging", async () => {
    const env = loadEnv({ NODE_ENV: "test", OWNER_REQUIRE_2FA: "true" });
    const stores = createInMemoryStores();
    const queues = createQueueInfrastructure(undefined);

    const app = await buildApp({
      env,
      authStore: stores.authStore,
      auditStore: stores.auditStore,
      platformStore: stores.platformStore,
      queues,
      async checkDb() {
        return true;
      },
    });

    // 1. Register Customer & test Customer isolation
    const regRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "buyer@example.com", password: "BuyerPassword#2026" },
    });
    assert.equal(regRes.statusCode, 201);
    assert.equal(regRes.json().role, UserRole.CUSTOMER);

    const custLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "buyer@example.com", password: "BuyerPassword#2026" },
    });
    assert.equal(custLogin.statusCode, 200);
    const custToken = custLogin.json().token as string;

    const custOk = await app.inject({
      method: "GET",
      url: "/api/v1/customer/overview",
      headers: { authorization: `Bearer ${custToken}` },
    });
    assert.equal(custOk.statusCode, 200);

    const custDeniedPartner = await app.inject({
      method: "GET",
      url: "/api/v1/partner/overview",
      headers: { authorization: `Bearer ${custToken}` },
    });
    assert.equal(custDeniedPartner.statusCode, 403);

    const custDeniedOwner = await app.inject({
      method: "GET",
      url: "/api/v1/owner/overview",
      headers: { authorization: `Bearer ${custToken}` },
    });
    assert.equal(custDeniedOwner.statusCode, 403);

    // 2. Create Partner & test Partner isolation
    await stores.authStore.createUser({
      email: "partner@example.com",
      passwordHash: await hashPassword("PartnerPass#2026"),
      role: UserRole.PARTNER,
    });
    const partnerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "partner@example.com", password: "PartnerPass#2026" },
    });
    const partnerToken = partnerLogin.json().token as string;
    const partnerOk = await app.inject({
      method: "GET",
      url: "/api/v1/partner/overview",
      headers: { authorization: `Bearer ${partnerToken}` },
    });
    assert.equal(partnerOk.statusCode, 200);
    assert.equal(partnerOk.json().categoryBStatus, "PENDING_RULE");

    const partnerDeniedOwner = await app.inject({
      method: "GET",
      url: "/api/v1/owner/overview",
      headers: { authorization: `Bearer ${partnerToken}` },
    });
    assert.equal(partnerDeniedOwner.statusCode, 403);

    // 3. Create Owner, verify 2FA is enforced before privileged access, enable 2FA, and verify audit log
    await stores.authStore.createUser({
      email: "bigola2823@example.com",
      passwordHash: await hashPassword("OwnerSecurePass#2026"),
      role: UserRole.OWNER,
    });
    const ownerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "bigola2823@example.com", password: "OwnerSecurePass#2026" },
    });
    const ownerToken = ownerLogin.json().token as string;

    const ownerBefore2fa = await app.inject({
      method: "GET",
      url: "/api/v1/owner/overview",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerBefore2fa.statusCode, 403);
    assert.equal(ownerBefore2fa.json().code, "MFA_REQUIRED");

    const setupRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/setup",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(setupRes.statusCode, 200);
    const manualKey = setupRes.json().manualKey as string;

    const enableRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/enable",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { code: generateTotpCode(manualKey) },
    });
    assert.equal(enableRes.statusCode, 200);

    const ownerAfter2fa = await app.inject({
      method: "GET",
      url: "/api/v1/owner/overview",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerAfter2fa.statusCode, 200);
    assert.equal(ownerAfter2fa.json().primarySupplier, "bigola2823");

    const updateSettingRes = await app.inject({
      method: "PUT",
      url: "/api/v1/owner/settings/bulk_pricing",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        value: { priceKoboPerTrillion: "120000", minBulkGameAmount: "10000000000000" },
        reason: "Testing configurable bulk pricing update",
      },
    });
    assert.equal(updateSettingRes.statusCode, 200);

    const auditRes = await app.inject({
      method: "GET",
      url: "/api/v1/owner/audit-logs",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(auditRes.statusCode, 200);
    const actions = (auditRes.json().logs as Array<{ actionType: string }>).map((l) => l.actionType);
    assert.ok(actions.includes("PLATFORM_SETTING_UPDATED"));
    assert.ok(actions.includes("USER_2FA_ENABLED"));
    assert.ok(actions.includes("USER_REGISTERED"));

    // 4. Duplicate registration rejected (409)
    const dupReg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "buyer@example.com", password: "BuyerPassword#2026" },
    });
    assert.equal(dupReg.statusCode, 409);

    // 5. Partner cannot access another Partner's records
    const partnerB = await stores.authStore.createUser({
      email: "partnerb@example.com",
      passwordHash: await hashPassword("PartnerBPass#2026"),
      role: UserRole.PARTNER,
    });
    const partnerUserA = await stores.authStore.findUserByEmail("partner@example.com");
    stores.partnersByUser.set(partnerUserA!.id, {
      id: "partner-a-id",
      referralCode: "REFA",
      displayName: "Partner A",
    });
    stores.partnersByUser.set(partnerB.id, {
      id: "partner-b-id",
      referralCode: "REFB",
      displayName: "Partner B",
    });
    stores.partnerCustomers.set("partner-b-id", [
      { id: "cust-b1", fullName: "Secret Client", category: "CATEGORY_A_PARTNER" },
    ]);

    const partnerAccessSelf = await app.inject({
      method: "GET",
      url: "/api/v1/partner/partner-a-id/customers",
      headers: { authorization: `Bearer ${partnerToken}` },
    });
    assert.equal(partnerAccessSelf.statusCode, 200);

    const partnerAccessOther = await app.inject({
      method: "GET",
      url: "/api/v1/partner/partner-b-id/customers",
      headers: { authorization: `Bearer ${partnerToken}` },
    });
    assert.equal(partnerAccessOther.statusCode, 403);

    // 6. 2FA setup locked when already enabled + single-use recovery code works once
    const reSetupBlocked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/setup",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(reSetupBlocked.statusCode, 409);

    const recoveryCodes = enableRes.json().recoveryCodes as string[];
    assert.equal(recoveryCodes.length, 8);

    const ownerLogin2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "bigola2823@example.com", password: "OwnerSecurePass#2026" },
    });
    const ownerToken2 = ownerLogin2.json().token as string;

    const recoverOk = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/recover",
      headers: { authorization: `Bearer ${ownerToken2}` },
      payload: { recoveryCode: recoveryCodes[0] },
    });
    assert.equal(recoverOk.statusCode, 200);
    assert.equal(recoverOk.json().remainingRecoveryCodes, 7);

    const recoverReuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/recover",
      headers: { authorization: `Bearer ${ownerToken2}` },
      payload: { recoveryCode: recoveryCodes[0] },
    });
    assert.equal(recoverReuse.statusCode, 401);

    // 7. Cookie auth enforces CSRF token on mutating requests
    const setCookies = ownerLogin2.cookies;
    const sessionCookie = setCookies.find((c) => c.name === "bigola_session")?.value;
    const csrfCookie = setCookies.find((c) => c.name === "bigola_csrf")?.value;
    assert.ok(sessionCookie && csrfCookie);

    const csrfMissing = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { bigola_session: sessionCookie, bigola_csrf: csrfCookie },
    });
    assert.equal(csrfMissing.statusCode, 403);

    const csrfValidLogout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { bigola_session: sessionCookie, bigola_csrf: csrfCookie },
      headers: { "x-csrf-token": csrfCookie },
    });
    assert.equal(csrfValidLogout.statusCode, 200);

    // Revoked session is rejected
    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${ownerToken2}` },
    });
    assert.equal(afterLogout.statusCode, 401);

    // 8. Rate limiting triggers 429 after 10 login attempts per minute
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { "x-forwarded-for": "198.51.100.77" },
        payload: { email: "buyer@example.com", password: "WrongPassword#123" },
      });
    }
    const rateLimited = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-forwarded-for": "198.51.100.77" },
      payload: { email: "buyer@example.com", password: "WrongPassword#123" },
    });
    assert.equal(rateLimited.statusCode, 429);

    await app.close();
  });
});

