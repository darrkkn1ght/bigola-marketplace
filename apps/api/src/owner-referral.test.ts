import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CustomerCategory, PrismaClient, UserRole } from "@prisma/client";
import { buildApp } from "./app.js";
import { generateTotpCode, hashPassword } from "./lib/crypto.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import { createPrismaStores } from "./lib/repositories.js";
import { loadIsolatedTestEnv } from "./lib/test-isolation.js";
import { AttributionService } from "./services/attribution.js";

const RUN_INFRA = process.env.RUN_INFRA_TESTS === "true";

describe("Owner Referral System", { skip: !RUN_INFRA }, () => {
  it("generates immutable unique Owner referral codes, validates links, attributes customers to Owner, and blocks self-referrals", async () => {
    const env = loadIsolatedTestEnv();
    const prisma = new PrismaClient();
    const stores = createPrismaStores(prisma);
    const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);
    const attributionService = new AttributionService(prisma, env.SESSION_SECRET);

    const app = await buildApp({
      env,
      authStore: stores.authStore,
      auditStore: stores.auditStore,
      platformStore: stores.platformStore,
      queues,
      prisma,
      attributionService,
      checkDb: async () => true,
    });

    const runId = Date.now().toString(36);
    const createdUserIds: string[] = [];
    const createdCustomerIds: string[] = [];

    try {
      const ownerEmail = `owner-ref-${runId}@bigola.test`;
      const ownerPhone = `0808${String(Date.now()).slice(-7)}`;
      const ownerPass = "OwnerRefPass123!";
      const ownerUser = await prisma.user.create({
        data: {
          email: ownerEmail,
          phone: ownerPhone,
          passwordHash: await hashPassword(ownerPass),
          role: UserRole.OWNER,
          isActive: true,
        },
      });
      createdUserIds.push(ownerUser.id);

      const owner2User = await prisma.user.create({
        data: {
          email: `owner2-ref-${runId}@bigola.test`,
          passwordHash: await hashPassword(ownerPass),
          role: UserRole.OWNER,
          isActive: true,
        },
      });
      createdUserIds.push(owner2User.id);

      const loginAndEnable2fa = async (email: string) => {
        const login = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email, password: ownerPass },
        });
        assert.equal(login.statusCode, 200);
        const token = login.json().token as string;
        const setup = await app.inject({
          method: "POST",
          url: "/api/v1/auth/2fa/setup",
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(setup.statusCode, 200);
        const enable = await app.inject({
          method: "POST",
          url: "/api/v1/auth/2fa/enable",
          headers: { authorization: `Bearer ${token}` },
          payload: { code: generateTotpCode(setup.json().manualKey) },
        });
        assert.equal(enable.statusCode, 200);
        return token;
      };

      const ownerToken = await loginAndEnable2fa(ownerEmail);
      const owner2Token = await loginAndEnable2fa(owner2User.email);

      // 1. Initial GET shows null referralCode
      const getBefore = await app.inject({
        method: "GET",
        url: "/api/v1/owner/referral",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(getBefore.statusCode, 200);
      assert.equal(getBefore.json().referralCode, null);

      // 2. Owner generates permanent referral code
      const customCode = `OLA-${runId.toUpperCase()}`;
      const gen1 = await app.inject({
        method: "POST",
        url: "/api/v1/owner/referral/generate",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { requestedCode: customCode },
      });
      assert.equal(gen1.statusCode, 201, `gen1 failed: ${gen1.body}`);
      assert.equal(gen1.json().referralCode, customCode);
      assert.ok(gen1.json().marketplaceUrl.endsWith(`/marketplace?ref=${customCode}`));
      assert.ok(gen1.json().registerUrl.endsWith(`/register?ref=${customCode}`));

      // 3. Re-generating on same Owner is rejected (immutable)
      const genAgain = await app.inject({
        method: "POST",
        url: "/api/v1/owner/referral/generate",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { requestedCode: `OLA-NEW-${runId.toUpperCase()}` },
      });
      assert.equal(genAgain.statusCode, 409);
      assert.equal(genAgain.json().code, "OWNER_REFERRAL_ALREADY_EXISTS");

      // 4. Uniqueness: another Owner & Partner cannot claim the same code
      const genCollision = await app.inject({
        method: "POST",
        url: "/api/v1/owner/referral/generate",
        headers: { authorization: `Bearer ${owner2Token}` },
        payload: { requestedCode: customCode },
      });
      assert.equal(genCollision.statusCode, 409);
      assert.equal(genCollision.json().code, "REFERRAL_CODE_TAKEN");

      const partnerCollision = await app.inject({
        method: "POST",
        url: "/api/v1/owner/partners",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          email: `partner-col-${runId}@bigola.test`,
          displayName: "Collision Partner",
          requestedReferralCode: customCode,
        },
      });
      assert.equal(partnerCollision.statusCode, 409);
      assert.equal(partnerCollision.json().code, "REFERRAL_CODE_TAKEN");

      // 5. Public referral validation endpoint accepts Owner code & sets signed cookie
      const valRes = await app.inject({
        method: "GET",
        url: `/api/v1/referrals/validate/${customCode}`,
      });
      assert.equal(valRes.statusCode, 200);
      assert.equal(valRes.json().valid, true);
      assert.equal(valRes.json().referralCode, customCode);

      // 6. Self-referral by Owner's email is blocked
      const selfEmailRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: ownerEmail,
          password: "CustomerPass123!",
          fullName: "Self Email",
          referralCode: customCode,
        },
      });
      assert.equal(selfEmailRes.statusCode, 400);
      assert.equal(selfEmailRes.json().code, "SELF_REFERRAL_NOT_ALLOWED");

      // 7. Self-referral by Owner's phone is blocked
      const selfPhoneRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: `other-email-${runId}@bigola.test`,
          phone: ownerPhone,
          password: "CustomerPass123!",
          fullName: "Self Phone",
          referralCode: customCode,
        },
      });
      assert.equal(selfPhoneRes.statusCode, 400);
      assert.equal(selfPhoneRes.json().code, "SELF_REFERRAL_NOT_ALLOWED");

      // 8. Valid customer registration with Owner code attributes directly to Owner (no fake Partner)
      const custRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: `cust-owner-${runId}@bigola.test`,
          password: "CustomerPass123!",
          fullName: "Owner Referred Buyer",
          referralCode: customCode,
        },
      });
      assert.equal(custRes.statusCode, 201);
      const custJson = custRes.json() as {
        id: string;
        customer: {
          id: string;
          category: string;
          attributedPartnerId: string | null;
          attributedOwnerUserId: string | null;
        };
      };
      createdUserIds.push(custJson.id);
      createdCustomerIds.push(custJson.customer.id);
      assert.equal(custJson.customer.category, CustomerCategory.CATEGORY_B_BIGOLA);
      assert.equal(custJson.customer.attributedPartnerId, null);
      assert.equal(custJson.customer.attributedOwnerUserId, ownerUser.id);
      assert.equal(await prisma.partner.findUnique({ where: { userId: ownerUser.id } }), null);

      // 9. Audit log recorded attributedOwnerUserId & GET /owner/referral shows count = 1
      const regAudit = await prisma.auditLog.findFirst({
        where: { actorUserId: custJson.id, actionType: "USER_REGISTERED" },
      });
      assert.ok(regAudit);
      assert.equal(
        (regAudit.afterState as { attributedOwnerUserId?: string }).attributedOwnerUserId,
        ownerUser.id
      );

      const getAfter = await app.inject({
        method: "GET",
        url: "/api/v1/owner/referral",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(getAfter.statusCode, 200);
      assert.equal(getAfter.json().referralCode, customCode);
      assert.equal(getAfter.json().attributedCustomersCount, 1);
    } finally {
      if (createdCustomerIds.length > 0) {
        await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } }).catch(() => undefined);
      }
      if (createdUserIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } }).catch(() => undefined);
        await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
      }
      await app.close();
      await queues.close();
      await prisma.$disconnect();
    }
  });
});
