import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { normalizeReferralCode, UserRole } from "@bigola/shared";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import type { AuditLogEntryInput, AuditLogRecord, AuditLogStore } from "./lib/audit.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import type { AuthStore, AuthUserRecord, PlatformStore, SessionRecord } from "./lib/repositories.js";
import { AttributionError, type AttributionService } from "./services/attribution.js";

function extractCookiePair(setCookieHeaders: string | string[] | undefined, name: string): string | null {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  for (const header of list) {
    const first = header.split(";")[0]?.trim() ?? "";
    if (first.startsWith(`${name}=`)) {
      return first;
    }
  }
  return null;
}

async function createIsolatedTestEnv() {
  const users = new Map<string, AuthUserRecord>();
  const sessions = new Map<string, SessionRecord>();
  const auditLogs: AuditLogRecord[] = [];
  const registeredCustomers = new Map<
    string,
    {
      id: string;
      email: string;
      fullName: string;
      category: string;
      attributedPartnerId: string | null;
      attributionSource: string;
    }
  >();

  const partners = new Map<
    string,
    { id: string; referralCode: string; displayName: string; status: "ACTIVE" | "SUSPENDED" }
  >([
    ["TESTPARTNERA", { id: "partner-a", referralCode: "TESTPARTNERA", displayName: "Test Partner A", status: "ACTIVE" }],
    ["TESTPARTNERB", { id: "partner-b", referralCode: "TESTPARTNERB", displayName: "Test Partner B", status: "ACTIVE" }],
    ["TESTINACTIVE", { id: "partner-x", referralCode: "TESTINACTIVE", displayName: "Inactive Partner", status: "SUSPENDED" }],
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
    async createUser(input) {
      const user: AuthUserRecord = {
        id: crypto.randomUUID(),
        email: input.email.toLowerCase(),
        phone: input.phone,
        passwordHash: input.passwordHash,
        role: input.role,
        isActive: true,
        mfaEnabled: false,
        mfaSecretEncrypted: null,
        mfaBackupCodesHash: null,
        mustChangePassword: false,
      };
      users.set(user.id, user);
      return user;
    },
    async updateUserMfa() {},
    async createSession(input) {
      const session: SessionRecord = {
        id: crypto.randomUUID(),
        userId: input.userId,
        tokenHash: input.tokenHash,
        mfaVerified: input.mfaVerified,
        expiresAt: input.expiresAt,
      };
      sessions.set(session.id, session);
      return session;
    },
    async findSessionByTokenHash(tokenHash) {
      for (const s of sessions.values()) {
        if (s.tokenHash === tokenHash) {
          const user = users.get(s.userId);
          return user ? { session: s, user } : null;
        }
      }
      return null;
    },
    async markSessionMfaVerified() {},
    async revokeSession() {},
  };

  const platformStore: PlatformStore = {
    async getSetting() {
      return null;
    },
    async setSetting(key, value) {
      return { key, value, description: null, updatedAt: new Date() };
    },
    async listPartners() {
      return [];
    },
    async findPartnerByUserId() {
      return null;
    },
    async listPartnerCustomers() {
      return [];
    },
  };

  const auditStore: AuditLogStore = {
    async create(entry: AuditLogEntryInput) {
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
    async list() {
      return auditLogs;
    },
  };

  const attributionStub = {
    async validateReferralCode(rawCode: string) {
      const code = normalizeReferralCode(rawCode);
      const p = partners.get(code);
      if (!p || p.status !== "ACTIVE") return null;
      return p;
    },
    async registerCustomerOnline(input: {
      email: string;
      phone?: string;
      password: string;
      fullName: string;
      lagoslifeUsername?: string;
      cookieReferralCode: string | null;
      submittedReferralCode?: string;
      ipAddress?: string;
    }) {
      const cookieCode = input.cookieReferralCode ? normalizeReferralCode(input.cookieReferralCode) : null;
      const bodyCode = input.submittedReferralCode ? normalizeReferralCode(input.submittedReferralCode) : null;

      if (cookieCode && bodyCode && cookieCode !== bodyCode) {
        throw new AttributionError(
          409,
          "REFERRAL_CONFLICT",
          "Submitted referral code conflicts with your captured referral link. Explicit resolution is required.",
          { cookieReferralCode: cookieCode, submittedReferralCode: bodyCode }
        );
      }

      const effectiveCode = cookieCode ?? bodyCode;
      let partner: { id: string; referralCode: string; status: string } | null = null;
      if (effectiveCode) {
        const p = partners.get(effectiveCode);
        if (!p || p.status !== "ACTIVE") {
          throw new AttributionError(400, "INVALID_REFERRAL_CODE", "Referral code is invalid or inactive.");
        }
        partner = p;
      }

      const user = await authStore.createUser({
        email: input.email,
        phone: input.phone ?? null,
        passwordHash: "hashed",
        role: UserRole.CUSTOMER,
      });

      const customer = {
        id: crypto.randomUUID(),
        email: input.email.toLowerCase(),
        fullName: input.fullName,
        category: partner ? "CATEGORY_A_PARTNER" : "CATEGORY_B_BIGOLA",
        attributedPartnerId: partner ? partner.id : null,
        attributionSource: cookieCode ? "REF_LINK" : bodyCode ? "REF_CODE" : "DIRECT",
      };
      registeredCustomers.set(customer.email, customer);
      return { user, customer };
    },
  } as unknown as AttributionService;

  const env = loadEnv({ NODE_ENV: "test", OWNER_REQUIRE_2FA: "true" });
  const queues = createQueueInfrastructure(undefined);

  const app = await buildApp({
    env,
    authStore,
    platformStore,
    auditStore,
    attributionService: attributionStub,
    queues,
    async checkDb() {
      return true;
    },
  });

  return { app, registeredCustomers };
}

describe("Stage 12 Referral Attribution & First-Valid-Wins Regression", () => {
  it("validates valid, invalid, inactive, repeated, and competing referral codes and attributes registration", async () => {
    const { app } = await createIsolatedTestEnv();

    // 1. Invalid code must return 404 and NOT set bigola_ref cookie
    const invalidRes = await app.inject({
      method: "GET",
      url: "/api/v1/referrals/validate/DOES_NOT_EXIST",
    });
    assert.equal(invalidRes.statusCode, 404);
    assert.equal(invalidRes.json().valid, false);
    assert.equal(extractCookiePair(invalidRes.headers["set-cookie"], "bigola_ref"), null);

    // 2. Inactive/suspended partner code must return 404 and NOT set bigola_ref cookie
    const inactiveRes = await app.inject({
      method: "GET",
      url: "/api/v1/referrals/validate/TESTINACTIVE",
    });
    assert.equal(inactiveRes.statusCode, 404);
    assert.equal(inactiveRes.json().valid, false);
    assert.equal(extractCookiePair(inactiveRes.headers["set-cookie"], "bigola_ref"), null);

    // 3. First valid code sets signed bigola_ref cookie
    const validRes = await app.inject({
      method: "GET",
      url: "/api/v1/referrals/validate/testpartnera",
    });
    assert.equal(validRes.statusCode, 200);
    assert.deepEqual(validRes.json(), {
      valid: true,
      firstReferralPreserved: false,
      referralCode: "TESTPARTNERA",
      partnerDisplayName: "Test Partner A",
    });
    const refCookie = extractCookiePair(validRes.headers["set-cookie"], "bigola_ref");
    assert.ok(refCookie, "Expected signed bigola_ref cookie to be set");

    // 4. Repeated visit preserves first referral
    const repeatRes = await app.inject({
      method: "GET",
      url: "/api/v1/referrals/validate/TESTPARTNERA",
      headers: { cookie: refCookie },
    });
    assert.equal(repeatRes.statusCode, 200);
    assert.equal(repeatRes.json().firstReferralPreserved, true);
    assert.equal(repeatRes.json().referralCode, "TESTPARTNERA");

    // 5. Competing referral code must NOT overwrite existing valid attribution
    const competingRes = await app.inject({
      method: "GET",
      url: "/api/v1/referrals/validate/TESTPARTNERB",
      headers: { cookie: refCookie },
    });
    assert.equal(competingRes.statusCode, 200);
    assert.equal(competingRes.json().firstReferralPreserved, true);
    assert.equal(competingRes.json().referralCode, "TESTPARTNERA");
    assert.equal(extractCookiePair(competingRes.headers["set-cookie"], "bigola_ref"), null);

    // 6. Registration with bigola_ref cookie (no body referralCode) attributes to TESTPARTNERA
    const regCookieOnly = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { cookie: refCookie },
      payload: {
        fullName: "First Visitor",
        email: "visitor1@example.test",
        password: "StrongPassword123!",
      },
    });
    assert.equal(regCookieOnly.statusCode, 201);
    assert.equal(regCookieOnly.json().customer.category, "CATEGORY_A_PARTNER");
    assert.equal(regCookieOnly.json().customer.attributedPartnerId, "partner-a");
    assert.equal(regCookieOnly.json().customer.attributionSource, "REF_LINK");

    // 7. Registration with matching bigola_ref cookie + body referralCode succeeds
    const regMatching = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { cookie: refCookie },
      payload: {
        fullName: "Second Visitor",
        email: "visitor2@example.test",
        referralCode: "TESTPARTNERA",
        password: "StrongPassword123!",
      },
    });
    assert.equal(regMatching.statusCode, 201);
    assert.equal(regMatching.json().customer.attributedPartnerId, "partner-a");

    // 8. Registration with competing body referralCode while bigola_ref cookie exists is rejected (409)
    const regConflict = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { cookie: refCookie },
      payload: {
        fullName: "Conflicting Visitor",
        email: "visitor3@example.test",
        referralCode: "TESTPARTNERB",
        password: "StrongPassword123!",
      },
    });
    assert.equal(regConflict.statusCode, 409);
    assert.equal(regConflict.json().code, "REFERRAL_CONFLICT");

    await app.close();
  });
});
