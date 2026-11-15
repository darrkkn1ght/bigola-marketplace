import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BankStatementFormat,
  CustomerCategory,
  GameAccountHealth,
  OrderStatus,
  Prisma,
  PrismaClient,
  UserRole,
} from "@prisma/client";
import { ONE_TRILLION } from "@bigola/shared";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { generateTotpCode, hashPassword } from "./lib/crypto.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import { createPrismaStores } from "./lib/repositories.js";
import { AttributionService } from "./services/attribution.js";
import { CommissionService } from "./services/commission.js";
import { InventoryService } from "./services/inventory.js";
import { NotificationService } from "./services/notification.js";
import { OrderService } from "./services/order.js";
import { VerificationService } from "./services/verification.js";

const RUN_INFRA = process.env.RUN_INFRA_TESTS === "true";

describe("Phase 5 Independent Payment Verification & OPay Reconciliation (Neon PostgreSQL)", { skip: !RUN_INFRA }, () => {
  it("enforces dual-control OPay accounts, split payments, permanent deduplication, full reversals, and commission re-accrual", async () => {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Refusing Phase 5 integration tests against NODE_ENV=production.");
    }

    const env = loadEnv();
    assert.equal(env.DISBURSEMENT_ENABLED, false);
    const prisma = new PrismaClient();
    const stores = createPrismaStores(prisma);
    const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);
    const attributionService = new AttributionService(prisma, env.SESSION_SECRET);
    const orderService = new OrderService(prisma);
    const inventoryService = new InventoryService(prisma);
    const commissionService = new CommissionService(prisma);
    const notificationService = new NotificationService(prisma);
    const verificationService = new VerificationService(prisma, commissionService, notificationService);

    const app = await buildApp({
      env,
      authStore: stores.authStore,
      auditStore: stores.auditStore,
      platformStore: stores.platformStore,
      queues,
      prisma,
      attributionService,
      orderService,
      inventoryService,
      verificationService,
      notificationService,
      checkDb: async () => true,
    });

    const runId = Date.now().toString(36);
    const createdUserIds: string[] = [];
    const createdCustomerIds: string[] = [];
    const createdPartnerIds: string[] = [];
    const createdOrderIds: string[] = [];
    const createdBankAccountIds: string[] = [];
    const createdUploadIds: string[] = [];
    const originalAccounts = await prisma.gameAccount.findMany();

    try {
      // 1. Setup Owner (2FA), 2 Partners, and Customer (Category A under Partner 1)
      const ownerUser = await prisma.user.create({
        data: {
          email: `p5-owner-${runId}@bigola.test`,
          passwordHash: await hashPassword("OwnerStrongPass123!"),
          role: UserRole.OWNER,
          mfaEnabled: false,
        },
      });
      const partner1User = await prisma.user.create({
        data: {
          email: `p5-partner1-${runId}@bigola.test`,
          passwordHash: await hashPassword("PartnerPass123!"),
          role: UserRole.PARTNER,
        },
      });
      const partner2User = await prisma.user.create({
        data: {
          email: `p5-partner2-${runId}@bigola.test`,
          passwordHash: await hashPassword("PartnerPass123!"),
          role: UserRole.PARTNER,
        },
      });
      const custUser = await prisma.user.create({
        data: {
          email: `p5-cust-${runId}@bigola.test`,
          passwordHash: await hashPassword("CustPass123!"),
          role: UserRole.CUSTOMER,
        },
      });
      const opsAdminUser = await prisma.user.create({
        data: {
          email: `p5-ops-${runId}@bigola.test`,
          passwordHash: await hashPassword("OpsPass123!"),
          role: UserRole.OPS_ADMIN,
        },
      });
      createdUserIds.push(ownerUser.id, partner1User.id, partner2User.id, custUser.id, opsAdminUser.id);

      const partner1 = await prisma.partner.create({
        data: { userId: partner1User.id, referralCode: `P5A-${runId.toUpperCase()}`, displayName: "Partner Verifier" },
      });
      const partner2 = await prisma.partner.create({
        data: { userId: partner2User.id, referralCode: `P5B-${runId.toUpperCase()}`, displayName: "Partner NonVerifier" },
      });
      createdPartnerIds.push(partner1.id, partner2.id);

      const cust = await prisma.customer.create({
        data: {
          userId: custUser.id,
          fullName: "Phase 5 Buyer",
          email: custUser.email,
          category: CustomerCategory.CATEGORY_A_PARTNER,
          attributedPartnerId: partner1.id,
        },
      });
      createdCustomerIds.push(cust.id);

      const loginAs = async (email: string, password: string) => {
        const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
        assert.equal(res.statusCode, 200);
        return res.json().token as string;
      };

      const ownerToken = await loginAs(ownerUser.email, "OwnerStrongPass123!");
      const setup2fa = await app.inject({
        method: "POST",
        url: "/api/v1/auth/2fa/setup",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/2fa/enable",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { code: generateTotpCode(setup2fa.json().manualKey) },
      });

      const partner1Token = await loginAs(partner1User.email, "PartnerPass123!");
      const partner2Token = await loginAs(partner2User.email, "PartnerPass123!");
      const custToken = await loginAs(custUser.email, "CustPass123!");
      const opsAdminToken = await loginAs(opsAdminUser.email, "OpsPass123!");

      // Sync fresh inventory on RESERVE_1 (100T)
      await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/sync",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          slotCode: "RESERVE_1",
          observedBalance: (100n * ONE_TRILLION).toString(),
          healthStatus: GameAccountHealth.ACTIVE,
          reason: "Phase 5 test balance",
        },
      });

      // 2. Partner-Owned OPay Account Dual-Control
      const proposeRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/bank-accounts/propose",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          ownerPartnerId: partner1.id,
          actionType: "CREATE",
          proposedData: {
            bankName: "OPay",
            accountNumber: `803${String(Date.now()).slice(-7)}`,
            accountName: "Partner OPay Receiving",
            isDefault: true,
          },
          reason: "Initial Partner OPay account",
        },
      });
      assert.equal(proposeRes.statusCode, 201);
      const changeReqId = proposeRes.json().request.id as string;

      // Partner 2 cannot confirm Partner 1's bank account
      const wrongConfirm = await app.inject({
        method: "POST",
        url: `/api/v1/partner/bank-account-requests/${changeReqId}/confirm`,
        headers: { authorization: `Bearer ${partner2Token}` },
        payload: { approve: true, reason: "Wrong partner" },
      });
      assert.equal(wrongConfirm.statusCode, 403);

      // Partner 1 confirms -> OPay account created
      const confirmRes = await app.inject({
        method: "POST",
        url: `/api/v1/partner/bank-account-requests/${changeReqId}/confirm`,
        headers: { authorization: `Bearer ${partner1Token}` },
        payload: { approve: true, reason: "Confirmed my OPay account" },
      });
      assert.equal(confirmRes.statusCode, 200);
      const opayAccountId = confirmRes.json().account.id as string;
      createdBankAccountIds.push(opayAccountId);

      // Owner cannot unilaterally edit Partner's OPay account
      const unilateralEdit = await app.inject({
        method: "PUT",
        url: `/api/v1/owner/bank-accounts/${opayAccountId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { accountName: "Hijacked" },
      });
      assert.equal(unilateralEdit.statusCode, 403);
      assert.equal(unilateralEdit.json().code, "DUAL_CONTROL_REQUIRED");

      // Owner proposes an update, Partner 1 rejects it -> account remains unchanged
      const proposeUpdateRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/bank-accounts/propose",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          ownerPartnerId: partner1.id,
          actionType: "UPDATE",
          receivingBankAccountId: opayAccountId,
          proposedData: { accountName: "Rejected Account Name" },
          reason: "Test partner rejection flow",
        },
      });
      assert.equal(proposeUpdateRes.statusCode, 201);
      const rejectReqId = proposeUpdateRes.json().request.id as string;

      const partnerRejectBankRes = await app.inject({
        method: "POST",
        url: `/api/v1/partner/bank-account-requests/${rejectReqId}/confirm`,
        headers: { authorization: `Bearer ${partner1Token}` },
        payload: { approve: false, reason: "Account name does not match my OPay profile" },
      });
      assert.equal(partnerRejectBankRes.statusCode, 200);
      assert.equal(partnerRejectBankRes.json().request.status, "REJECTED");
      assert.equal(partnerRejectBankRes.json().account, null);
      const unchangedBank = await prisma.receivingBankAccount.findUnique({ where: { id: opayAccountId } });
      assert.equal(unchangedBank?.accountName, "Partner OPay Receiving");

      // 3. Verifier Authorization Grant/Revoke & Privilege Isolation
      // Missing/empty reason must be rejected (400)
      const missingReasonGrant = await app.inject({
        method: "PUT",
        url: `/api/v1/owner/partners/${partner1.id}/verification-permission`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { canVerifyPayments: true, reason: "" },
      });
      assert.equal(missingReasonGrant.statusCode, 400);

      const grantRes = await app.inject({
        method: "PUT",
        url: `/api/v1/owner/partners/${partner1.id}/verification-permission`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { canVerifyPayments: true, reason: "Authorize primary partner verifier" },
      });
      assert.equal(grantRes.statusCode, 200);

      // Non-verifier Partner 2 gets 403 on verification queue & statements
      const p2Queue = await app.inject({
        method: "GET",
        url: "/api/v1/verification/queue",
        headers: { authorization: `Bearer ${partner2Token}` },
      });
      assert.equal(p2Queue.statusCode, 403);

      // OPS_ADMIN must NOT have access to payment verification endpoints (queue, statements, approve, reject, reverse, accountability)
      const opsQueue = await app.inject({
        method: "GET",
        url: "/api/v1/verification/queue",
        headers: { authorization: `Bearer ${opsAdminToken}` },
      });
      assert.equal(opsQueue.statusCode, 403);

      const opsBankAccounts = await app.inject({
        method: "GET",
        url: "/api/v1/verification/bank-accounts",
        headers: { authorization: `Bearer ${opsAdminToken}` },
      });
      assert.equal(opsBankAccounts.statusCode, 403);

      const opsStatementsGet = await app.inject({
        method: "GET",
        url: "/api/v1/verification/statements",
        headers: { authorization: `Bearer ${opsAdminToken}` },
      });
      assert.equal(opsStatementsGet.statusCode, 403);

      const opsUpload = await app.inject({
        method: "POST",
        url: "/api/v1/verification/statements",
        headers: { authorization: `Bearer ${opsAdminToken}` },
        payload: {
          receivingBankAccountId: opayAccountId,
          fileName: "ops-denied.csv",
          format: "CSV",
          lines: [
            {
              transactionReference: "OPAY-OPS-DENIED",
              amountKobo: "100000",
              creditedAt: new Date().toISOString(),
            },
          ],
        },
      });
      assert.equal(opsUpload.statusCode, 403);

      const opsApprove = await app.inject({
        method: "POST",
        url: "/api/v1/verification/orders/00000000-0000-0000-0000-000000000000/approve",
        headers: { authorization: `Bearer ${opsAdminToken}` },
        payload: {
          receivingBankAccountId: opayAccountId,
          bankCreditConfirmed: true,
          reason: "Should be denied",
        },
      });
      assert.equal(opsApprove.statusCode, 403);

      const opsReject = await app.inject({
        method: "POST",
        url: "/api/v1/verification/orders/00000000-0000-0000-0000-000000000000/reject",
        headers: { authorization: `Bearer ${opsAdminToken}` },
        payload: { reason: "Should be denied" },
      });
      assert.equal(opsReject.statusCode, 403);

      const opsReverse = await app.inject({
        method: "POST",
        url: "/api/v1/verification/orders/00000000-0000-0000-0000-000000000000/reverse",
        headers: { authorization: `Bearer ${opsAdminToken}` },
        payload: {
          decisionId: "00000000-0000-0000-0000-000000000000",
          reason: "Should be denied",
        },
      });
      assert.equal(opsReverse.statusCode, 403);

      const opsAccountability = await app.inject({
        method: "GET",
        url: "/api/v1/verification/accountability",
        headers: { authorization: `Bearer ${opsAdminToken}` },
      });
      assert.equal(opsAccountability.statusCode, 403);

      // OPS_ADMIN retains unrelated existing permissions (e.g. catalog view)
      const opsCatalog = await app.inject({
        method: "GET",
        url: "/api/v1/catalog/pricing",
        headers: { authorization: `Bearer ${opsAdminToken}` },
      });
      assert.equal(opsCatalog.statusCode, 200);

      // Partner 1 verifier gets 403 on Owner admin routes
      const p1AdminCheck = await app.inject({
        method: "PUT",
        url: "/api/v1/owner/pricing/bulk",
        headers: { authorization: `Bearer ${partner1Token}` },
        payload: { priceKoboPerTrillion: "90000", minBulkGameAmount: (10n * ONE_TRILLION).toString(), reason: "No" },
      });
      assert.equal(p1AdminCheck.statusCode, 403);

      // 4. Create Order 1 (10T = ₦10,000 = 1,000,000 kobo), Customer fetches OPay instructions & submits proof
      const ord1Res = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: { authorization: `Bearer ${custToken}`, "idempotency-key": `p5-ord1-${runId}` },
        payload: { orderType: "BULK", gameAmount: (10n * ONE_TRILLION).toString(), recipientLagoslifeUsername: "p5_buyer" },
      });
      assert.equal(ord1Res.statusCode, 201);
      const ord1 = ord1Res.json().order;
      createdOrderIds.push(ord1.id);

      const instrRes = await app.inject({
        method: "GET",
        url: `/api/v1/orders/${ord1.id}/payment-instructions`,
        headers: { authorization: `Bearer ${custToken}` },
      });
      assert.equal(instrRes.statusCode, 200);
      assert.ok(instrRes.json().receivingAccounts.some((a: { id: string }) => a.id === opayAccountId));

      const proof1Res = await app.inject({
        method: "POST",
        url: `/api/v1/orders/${ord1.id}/payment-proof`,
        headers: { authorization: `Bearer ${custToken}` },
        payload: {
          receivingBankAccountId: opayAccountId,
          bankReference: `OPAY-SPLIT1-${runId}`,
          senderAccountName: "Phase 5 Buyer",
          claimedAmountKobo: "600000",
          proofFileKey: `proof1-${runId}`,
          isSplitTransfer: true,
        },
      });
      assert.equal(proof1Res.statusCode, 201);
      assert.equal(proof1Res.json().order.status, OrderStatus.PAYMENT_SUBMITTED);

      // Both Owner and Partner 1 received PAYMENT_AWAITING_REVIEW notification
      const p1Notifs = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: { authorization: `Bearer ${partner1Token}` },
      });
      assert.ok(p1Notifs.json().unreadCount >= 1);

      // 5. Upload OPay Statement (₦6,000 + ₦4,000 + ₦4,000 repayment + ₦7,000 + ₦3,000) -> Never auto-approves!
      const stmtRes = await app.inject({
        method: "POST",
        url: "/api/v1/verification/statements",
        headers: { authorization: `Bearer ${partner1Token}` },
        payload: {
          receivingBankAccountId: opayAccountId,
          fileName: "opay_filtered.csv",
          format: BankStatementFormat.CSV,
          lines: [
            { transactionReference: `OPAY-SPLIT1-${runId}`, amountKobo: "600000", creditedAt: new Date().toISOString() },
            { transactionReference: `OPAY-SPLIT2-${runId}`, amountKobo: "400000", creditedAt: new Date().toISOString() },
            { transactionReference: `OPAY-REPAY-${runId}`, amountKobo: "400000", creditedAt: new Date().toISOString() },
            { transactionReference: `OPAY-MULTI1-${runId}`, amountKobo: "700000", creditedAt: new Date().toISOString() },
            { transactionReference: `OPAY-MULTI2-${runId}`, amountKobo: "300000", creditedAt: new Date().toISOString() },
          ],
        },
      });
      assert.equal(stmtRes.statusCode, 201);
      createdUploadIds.push(stmtRes.json().upload.id);
      const [line6k, line4k, lineRepay4k, line7k, line3k] = stmtRes.json().lines as Array<{ id: string }>;

      // Order 1 must still be PAYMENT_SUBMITTED and verified revenue = 0
      const acctBefore = await app.inject({
        method: "GET",
        url: "/api/v1/verification/accountability",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(acctBefore.json().paymentsVerified.netVerifiedCustomerPaymentsKobo, "0");

      // 6. Split Payment Step 1: Partner 1 independently approves ₦6,000 -> PAYMENT_EXCEPTION_REVIEW, 0 commission
      const app6k = await app.inject({
        method: "POST",
        url: `/api/v1/verification/orders/${ord1.id}/approve`,
        headers: { authorization: `Bearer ${partner1Token}` },
        payload: {
          receivingBankAccountId: opayAccountId,
          statementLineIds: [line6k.id],
          bankCreditConfirmed: true,
          reason: "Confirmed first split ₦6,000 OPay credit",
        },
      });
      assert.equal(app6k.statusCode, 200);
      assert.equal(app6k.json().orderStatus, OrderStatus.PAYMENT_EXCEPTION_REVIEW);
      assert.equal(app6k.json().cumulativeCreditsKobo, "600000");

      assert.equal(await prisma.commissionRecord.count({ where: { orderId: ord1.id } }), 0);

      // 7. Split Payment Step 2: Owner independently approves ₦4,000 -> READY_FOR_FULFILMENT + Commission Cycle 1
      const app4k = await app.inject({
        method: "POST",
        url: `/api/v1/verification/orders/${ord1.id}/approve`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          receivingBankAccountId: opayAccountId,
          statementLineIds: [line4k.id],
          bankCreditConfirmed: true,
          reason: "Confirmed second split ₦4,000 OPay credit",
        },
      });
      assert.equal(app4k.statusCode, 200);
      assert.equal(app4k.json().orderStatus, OrderStatus.READY_FOR_FULFILMENT);
      assert.equal(app4k.json().cumulativeCreditsKobo, "1000000");
      const dec4kId = app4k.json().decisionId as string;

      assert.equal(await prisma.commissionLedgerEntry.count({ where: { commissionRecord: { orderId: ord1.id } } }), 1);

      // 8. Reversal Policy: Partial reversal rejected (400); Concurrent full reversals yield 1x 200 + 1x 409
      const partialRev = await app.inject({
        method: "POST",
        url: `/api/v1/verification/orders/${ord1.id}/reverse`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { decisionId: dec4kId, reversalAmountKobo: "200000", reason: "Partial reversal test" },
      });
      assert.equal(partialRev.statusCode, 400);
      assert.equal(partialRev.json().code, "PARTIAL_REVERSAL_UNSUPPORTED");

      const revParallel = await Promise.all([
        app.inject({
          method: "POST",
          url: `/api/v1/verification/orders/${ord1.id}/reverse`,
          headers: { authorization: `Bearer ${ownerToken}` },
          payload: { decisionId: dec4kId, reason: "Chargeback on ₦4,000 split" },
        }),
        app.inject({
          method: "POST",
          url: `/api/v1/verification/orders/${ord1.id}/reverse`,
          headers: { authorization: `Bearer ${ownerToken}` },
          payload: { decisionId: dec4kId, reason: "Duplicate concurrent reversal" },
        }),
      ]);
      assert.equal(revParallel.filter((r) => r.statusCode === 200).length, 1);
      assert.equal(revParallel.filter((r) => r.statusCode === 409).length, 1);

      const ord1AfterRev = await prisma.order.findUniqueOrThrow({ where: { id: ord1.id } });
      assert.equal(ord1AfterRev.status, OrderStatus.PAYMENT_EXCEPTION_REVIEW);
      assert.equal(ord1AfterRev.fundingCycle, 2);
      assert.ok(ord1AfterRev.expiresAt !== null, "Reservation expiry must be restored after reversal");

      // Accountability after reversal: net verified = 600000, net partner commission = 0
      const acctAfterRev = await app.inject({
        method: "GET",
        url: "/api/v1/verification/accountability",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(acctAfterRev.json().paymentsVerified.netVerifiedCustomerPaymentsKobo, "600000");
      assert.equal(acctAfterRev.json().commissionEntitlements.totalNetPartnerEntitlementKobo, "0");

      // 9. Permanent Bank-Credit Deduplication: Reversed line4k AND its reference CANNOT be reused on Order 2
      const ord2Res = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: { authorization: `Bearer ${custToken}`, "idempotency-key": `p5-ord2-${runId}` },
        payload: { orderType: "BULK", gameAmount: (10n * ONE_TRILLION).toString(), recipientLagoslifeUsername: "p5_buyer" },
      });
      assert.equal(ord2Res.statusCode, 201);
      const ord2 = ord2Res.json().order;
      createdOrderIds.push(ord2.id);

      await app.inject({
        method: "POST",
        url: `/api/v1/orders/${ord2.id}/payment-proof`,
        headers: { authorization: `Bearer ${custToken}` },
        payload: {
          receivingBankAccountId: opayAccountId,
          bankReference: `OPAY-MULTI-${runId}`,
          senderAccountName: "Phase 5 Buyer",
          claimedAmountKobo: "1000000",
          proofFileKey: `proof2-${runId}`,
        },
      });

      const reuseLineRes = await app.inject({
        method: "POST",
        url: `/api/v1/verification/orders/${ord2.id}/approve`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          receivingBankAccountId: opayAccountId,
          statementLineIds: [line4k.id],
          bankCreditConfirmed: true,
          reason: "Attempt to reuse reversed statement line",
        },
      });
      assert.equal(reuseLineRes.statusCode, 409);

      const reuseRefManual = await app.inject({
        method: "POST",
        url: `/api/v1/verification/orders/${ord2.id}/approve`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          receivingBankAccountId: opayAccountId,
          manualVerificationException: true,
          bankCreditConfirmed: true,
          bankCreditReference: `opay split2 ${runId}`, // normalizes identically to OPAY-SPLIT2-...
          bankCreditAmountKobo: "400000",
          reason: "Attempt to reuse reversed bank reference manually",
        },
      });
      assert.equal(reuseRefManual.statusCode, 409);
      assert.equal(reuseRefManual.json().code, "DUPLICATE_BANK_CREDIT");

      // 10. Commission Re-Accrual on Order 1 Repayment (Cycle 2) + Multi-Line Join on Order 2
      const repayRes = await app.inject({
        method: "POST",
        url: `/api/v1/verification/orders/${ord1.id}/approve`,
        headers: { authorization: `Bearer ${partner1Token}` },
        payload: {
          receivingBankAccountId: opayAccountId,
          statementLineIds: [lineRepay4k.id],
          bankCreditConfirmed: true,
          reason: "Repayment of ₦4,000 with fresh OPay credit",
        },
      });
      assert.equal(repayRes.statusCode, 200);
      assert.equal(repayRes.json().orderStatus, OrderStatus.READY_FOR_FULFILMENT);

      // Order 1 now has 3 ledger entries: Cycle 1 ACCRUAL (+500k), Cycle 1 REVERSAL (-500k), Cycle 2 ACCRUAL (+500k)
      const ord1Ledger = await prisma.commissionLedgerEntry.findMany({
        where: { commissionRecord: { orderId: ord1.id } },
        orderBy: { createdAt: "asc" },
      });
      assert.equal(ord1Ledger.length, 3);
      assert.equal(ord1Ledger[2].fundingCycle, 2);

      // Multi-line join on Order 2 (₦7,000 + ₦3,000 = ₦10,000 in one decision)
      const multiApprove = await app.inject({
        method: "POST",
        url: `/api/v1/verification/orders/${ord2.id}/approve`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          receivingBankAccountId: opayAccountId,
          statementLineIds: [line7k.id, line3k.id],
          bankCreditConfirmed: true,
          reason: "Multi-line split approval ₦7k + ₦3k",
        },
      });
      assert.equal(multiApprove.statusCode, 200);
      assert.equal(multiApprove.json().orderStatus, OrderStatus.READY_FOR_FULFILMENT);

      // No real disbursements
      assert.equal(await prisma.disbursementJob.count({ where: { orderId: { in: createdOrderIds } } }), 0);
    } finally {
      if (createdOrderIds.length > 0) {
        await prisma.notification.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.paymentDecisionStatementLine.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.paymentVerificationDecision.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.paymentProof.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.commissionLedgerEntry.deleteMany({
          where: { commissionRecord: { orderId: { in: createdOrderIds } } },
        });
        await prisma.commissionRecord.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.inventoryLedger.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.inventoryReservation.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      }
      if (createdUploadIds.length > 0) {
        await prisma.bankStatementLine.deleteMany({ where: { statementUploadId: { in: createdUploadIds } } });
        await prisma.bankStatementUpload.deleteMany({ where: { id: { in: createdUploadIds } } });
      }
      if (createdOrderIds.length > 0) {
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      }
      if (createdBankAccountIds.length > 0) {
        await prisma.receivingBankAccountChangeRequest.deleteMany({
          where: { receivingBankAccountId: { in: createdBankAccountIds } },
        });
        await prisma.receivingBankAccount.deleteMany({ where: { id: { in: createdBankAccountIds } } });
      }
      if (createdPartnerIds.length > 0) {
        await prisma.receivingBankAccountChangeRequest.deleteMany({
          where: { ownerPartnerId: { in: createdPartnerIds } },
        });
      }
      if (createdCustomerIds.length > 0) {
        await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
      }
      if (createdPartnerIds.length > 0) {
        await prisma.partner.deleteMany({ where: { id: { in: createdPartnerIds } } });
      }
      if (createdUserIds.length > 0) {
        await prisma.notification.deleteMany({ where: { recipientUserId: { in: createdUserIds } } });
        await prisma.inventoryLedger.deleteMany({ where: { createdById: { in: createdUserIds } } });
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
        await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
      for (const orig of originalAccounts) {
        await prisma.gameAccount.update({
          where: { id: orig.id },
          data: {
            lastKnownBalance: orig.lastKnownBalance,
            reservedForOrders: orig.reservedForOrders,
            logicalAllocationAmount: orig.logicalAllocationAmount,
            healthStatus: orig.healthStatus,
            lastSyncedAt: orig.lastSyncedAt,
          },
        });
      }
      await app.close();
      await queues.close();
      await prisma.$disconnect();
    }
  });
});

