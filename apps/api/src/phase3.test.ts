import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CommissionLedgerEntryType,
  CommissionSettlementStatus,
  CustomerCategory,
  OrderStatus,
  PrismaClient,
  ProofVerificationStatus,
  UserRole,
} from "@prisma/client";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import {
  generateTotpCode,
  hashPassword,
  signReferralCookieValue,
  verifyReferralCookieValue,
} from "./lib/crypto.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import { createPrismaStores } from "./lib/repositories.js";
import { AttributionService } from "./services/attribution.js";
import { CommissionError, CommissionService } from "./services/commission.js";

const RUN_INFRA = process.env.RUN_INFRA_TESTS === "true";

describe("Phase 3 Signed Referral Cookie", () => {
  it("signs, verifies, and rejects tampered referral cookies", () => {
    const secret = "dev_only_session_secret_replace_in_production_32chars";
    const signed = signReferralCookieValue("BGO-TEST1", secret);
    assert.equal(verifyReferralCookieValue(signed, secret), "BGO-TEST1");
    assert.equal(verifyReferralCookieValue(`${signed}tamper`, secret), null);
    assert.equal(verifyReferralCookieValue(signed, secret, -1), null);
  });
});

describe("Phase 3 Attribution & Commission Integrity (Neon PostgreSQL)", { skip: !RUN_INFRA }, () => {
  it("enforces first-valid-wins, mismatch rejection, offline conflicts, and immutable CommissionService", async () => {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Refusing Phase 3 integration tests against NODE_ENV=production.");
    }

    const env = loadEnv();
    const prisma = new PrismaClient();
    const stores = createPrismaStores(prisma);
    const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);
    const attributionService = new AttributionService(prisma, env.SESSION_SECRET);
    const commissionService = new CommissionService(prisma);

    const app = await buildApp({
      env,
      authStore: stores.authStore,
      auditStore: stores.auditStore,
      platformStore: stores.platformStore,
      queues,
      prisma,
      attributionService,
      async checkDb() {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      },
    });

    const ts = Date.now();
    const createdUserIds: string[] = [];
    const createdCustomerIds: string[] = [];
    const createdOrderIds: string[] = [];

    try {
      // 1. Create temporary Owner with 2FA enabled
      const ownerUser = await stores.authStore.createUser({
        email: `p3_owner_${ts}@example.com`,
        passwordHash: await hashPassword("OwnerP3Pass#2026"),
        role: UserRole.OWNER,
      });
      createdUserIds.push(ownerUser.id);

      const ownerLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: ownerUser.email, password: "OwnerP3Pass#2026" },
      });
      const ownerToken = ownerLogin.json().token as string;
      const setup2fa = await app.inject({
        method: "POST",
        url: "/api/v1/auth/2fa/setup",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      const totpSecret = setup2fa.json().manualKey as string;
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/2fa/enable",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { code: generateTotpCode(totpSecret) },
      });

      // 2. Owner creates Partner A and Partner B
      const codeA = `BGOA${String(ts).slice(-4)}`;
      const codeB = `BGOB${String(ts).slice(-4)}`;

      const pARes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/partners",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          email: `p3_partner_a_${ts}@example.com`,
          password: "PartnerAPass#2026",
          displayName: "Partner Alpha",
          requestedReferralCode: codeA,
        },
      });
      assert.equal(pARes.statusCode, 201);
      const partnerA = pARes.json().partner as { id: string; referralCode: string };
      createdUserIds.push(pARes.json().user.id);

      const pBRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/partners",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          email: `p3_partner_b_${ts}@example.com`,
          password: "PartnerBPass#2026",
          displayName: "Partner Beta",
          requestedReferralCode: codeB,
        },
      });
      assert.equal(pBRes.statusCode, 201);
      const partnerB = pBRes.json().partner as { id: string; referralCode: string };
      createdUserIds.push(pBRes.json().user.id);

      // 3. First-valid-referral-wins before registration
      const valA = await app.inject({
        method: "GET",
        url: `/api/v1/referrals/validate/${codeA}`,
      });
      assert.equal(valA.statusCode, 200);
      const refCookie = valA.cookies.find((c) => c.name === "bigola_ref")?.value;
      assert.ok(refCookie);

      const valB = await app.inject({
        method: "GET",
        url: `/api/v1/referrals/validate/${codeB}`,
        cookies: { bigola_ref: refCookie },
      });
      assert.equal(valB.statusCode, 200);
      assert.equal(valB.json().firstReferralPreserved, true);
      assert.equal(valB.json().referralCode, codeA);

      // 4. Reject cookie vs. body referral mismatch (409 REFERRAL_CONFLICT)
      const mismatchReg = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        cookies: { bigola_ref: refCookie },
        payload: {
          email: `p3_cust_mismatch_${ts}@example.com`,
          password: "CustPass#2026",
          fullName: "Mismatch Buyer",
          referralCode: codeB,
        },
      });
      assert.equal(mismatchReg.statusCode, 409);
      assert.equal(mismatchReg.json().code, "REFERRAL_CONFLICT");

      // 5. Register Customer 1 with Partner A referral cookie -> Category A
      const cust1Reg = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        cookies: { bigola_ref: refCookie },
        payload: {
          email: `p3_cust1_${ts}@example.com`,
          phone: `0803${String(ts).slice(-7)}`,
          password: "CustPass#2026",
          fullName: "Category A Buyer",
          lagoslifeUsername: `catabuyer_${ts}`,
        },
      });
      assert.equal(cust1Reg.statusCode, 201);
      assert.equal(cust1Reg.json().customer.category, CustomerCategory.CATEGORY_A_PARTNER);
      assert.equal(cust1Reg.json().customer.attributedPartnerId, partnerA.id);
      createdUserIds.push(cust1Reg.json().id);
      createdCustomerIds.push(cust1Reg.json().customer.id);

      // 6. Register Customer 2 without referral -> Category B
      const cust2Reg = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: `p3_cust2_${ts}@example.com`,
          password: "CustPass#2026",
          fullName: "Category B Direct",
        },
      });
      assert.equal(cust2Reg.statusCode, 201);
      assert.equal(cust2Reg.json().customer.category, CustomerCategory.CATEGORY_B_BIGOLA);
      assert.equal(cust2Reg.json().customer.attributedPartnerId, null);
      createdUserIds.push(cust2Reg.json().id);
      createdCustomerIds.push(cust2Reg.json().customer.id);

      // 7. Partner B registers offline customer; Partner A tries same phone -> 409 conflict (masked, no overwrite)
      const pALogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: `p3_partner_a_${ts}@example.com`, password: "PartnerAPass#2026" },
      });
      const pAToken = pALogin.json().token as string;

      const pBLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: `p3_partner_b_${ts}@example.com`, password: "PartnerBPass#2026" },
      });
      const pBToken = pBLogin.json().token as string;

      const sharedPhone = `0809${String(ts).slice(-7)}`;
      const offlineOk = await app.inject({
        method: "POST",
        url: "/api/v1/partner/customers/offline",
        headers: { authorization: `Bearer ${pBToken}` },
        payload: { fullName: "WhatsApp Buyer", phone: sharedPhone },
      });
      assert.equal(offlineOk.statusCode, 201);
      const offlineCustId = offlineOk.json().customer.id as string;
      createdCustomerIds.push(offlineCustId);

      const offlineConflict = await app.inject({
        method: "POST",
        url: "/api/v1/partner/customers/offline",
        headers: { authorization: `Bearer ${pAToken}` },
        payload: {
          fullName: "Attempted Steal",
          phone: `+234${sharedPhone.slice(1)}`,
        },
      });
      assert.equal(offlineConflict.statusCode, 409);
      assert.equal(offlineConflict.json().code, "ATTRIBUTION_CONFLICT");

      // Partner A cannot access Partner B's customer orders
      const crossPartnerDenied = await app.inject({
        method: "GET",
        url: `/api/v1/partner/customers/${offlineCustId}/orders`,
        headers: { authorization: `Bearer ${pAToken}` },
      });
      assert.equal(crossPartnerDenied.statusCode, 403);

      // 8. CommissionService integrity tests (unverified blocked, Cat A 50/50 odd kobo, duplicate blocked, Cat B PENDING_RULE, append-only reversal)
      const unpaidOrder = await prisma.order.create({
        data: {
          orderNumber: `ORD-UNP-${ts}`,
          paymentReference: `BGO-UNP-${ts}`,
          customerId: cust1Reg.json().customer.id,
          customerCategory: CustomerCategory.CATEGORY_A_PARTNER,
          partnerId: partnerA.id,
          recipientLagoslifeUsername: `catabuyer_${ts}`,
          gameAmountRequested: "10000000000000",
          fiatAmountKobo: 100001n,
          pricingSnapshot: { rateKoboPerTrillion: "100000" },
          status: OrderStatus.PROOF_SUBMITTED,
        },
      });
      createdOrderIds.push(unpaidOrder.id);

      await assert.rejects(
        commissionService.recordCommissionForVerifiedOrder(unpaidOrder.id, ownerUser.id),
        (err: unknown) => err instanceof CommissionError && err.code === "ORDER_NOT_VERIFIED"
      );

      // Mark order verified + approved proof in test setup (no HTTP route exposes this!)
      await prisma.paymentProof.create({
        data: {
          orderId: unpaidOrder.id,
          bankReference: `BNK-${ts}`,
          senderAccountName: "Category A Buyer",
          claimedAmountKobo: 100001n,
          proofFileKey: "test/proof.png",
          verificationStatus: ProofVerificationStatus.APPROVED,
          verifiedById: ownerUser.id,
          verifiedAt: new Date(),
        },
      });
      await prisma.order.update({
        where: { id: unpaidOrder.id },
        data: { status: OrderStatus.PAYMENT_VERIFIED },
      });

      const catARecord = await commissionService.recordCommissionForVerifiedOrder(
        unpaidOrder.id,
        ownerUser.id
      );
      assert.equal(catARecord.partnerEntitlementKobo, 50000n);
      assert.equal(catARecord.ownerEntitlementKobo, 50001n);
      assert.equal(catARecord.settlementStatus, CommissionSettlementStatus.ACCRUED);

      await assert.rejects(
        commissionService.recordCommissionForVerifiedOrder(unpaidOrder.id, ownerUser.id),
        (err: unknown) => err instanceof CommissionError && err.code === "DUPLICATE_COMMISSION"
      );

      await commissionService.approveForPayout(catARecord.id, ownerUser.id, "Ready for payout");
      await commissionService.reverseCommission(catARecord.id, ownerUser.id, "Order refunded");

      const ledgerEntries = await prisma.commissionLedgerEntry.findMany({
        where: { commissionRecordId: catARecord.id },
        orderBy: { createdAt: "asc" },
      });
      assert.deepEqual(
        ledgerEntries.map((e) => e.entryType),
        [
          CommissionLedgerEntryType.ACCRUAL,
          CommissionLedgerEntryType.APPROVAL,
          CommissionLedgerEntryType.REVERSAL,
        ]
      );
      assert.equal(ledgerEntries[0].partnerDeltaKobo, 50000n);
      assert.equal(ledgerEntries[2].partnerDeltaKobo, -50000n);

      // Category B verified order stays PENDING_RULE with null entitlements
      const catBOrder = await prisma.order.create({
        data: {
          orderNumber: `ORD-CATB-${ts}`,
          paymentReference: `BGO-CATB-${ts}`,
          customerId: cust2Reg.json().customer.id,
          customerCategory: CustomerCategory.CATEGORY_B_BIGOLA,
          partnerId: null,
          recipientLagoslifeUsername: `catb_${ts}`,
          gameAmountRequested: "10000000000000",
          fiatAmountKobo: 1000000n,
          pricingSnapshot: { rateKoboPerTrillion: "100000" },
          status: OrderStatus.PAYMENT_VERIFIED,
          paymentProofs: {
            create: {
              bankReference: `BNK-B-${ts}`,
              senderAccountName: "Category B Direct",
              claimedAmountKobo: 1000000n,
              proofFileKey: "test/proof-b.png",
              verificationStatus: ProofVerificationStatus.APPROVED,
              verifiedById: ownerUser.id,
              verifiedAt: new Date(),
            },
          },
        },
      });
      createdOrderIds.push(catBOrder.id);

      const catBRecord = await commissionService.recordCommissionForVerifiedOrder(
        catBOrder.id,
        ownerUser.id
      );
      assert.equal(catBRecord.settlementStatus, CommissionSettlementStatus.PENDING_RULE);
      assert.equal(catBRecord.partnerEntitlementKobo, null);
      assert.equal(catBRecord.ownerEntitlementKobo, null);
    } finally {
      // Clean up test records in FK-safe order
      if (createdOrderIds.length) {
        await prisma.commissionLedgerEntry.deleteMany({
          where: { commissionRecord: { orderId: { in: createdOrderIds } } },
        });
        await prisma.commissionRecord.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.paymentProof.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      }
      if (createdCustomerIds.length) {
        await prisma.attributionConflict.deleteMany({
          where: { existingCustomerId: { in: createdCustomerIds } },
        });
        await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
      }
      if (createdUserIds.length) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
        await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } });
        await prisma.partner.deleteMany({ where: { userId: { in: createdUserIds } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
      await app.close();
      await queues.close();
      await prisma.$disconnect();
    }
  });
});

