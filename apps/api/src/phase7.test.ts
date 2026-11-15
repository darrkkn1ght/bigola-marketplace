import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import crypto from "node:crypto";
import { hashPassword } from "./lib/crypto.js";
import {
  CommissionSettlementStatus,
  CustomerCategory,
  GameAccountRole,
  InventoryReservationStatus,
  OrderChannel,
  OrderStatus,
  OrderType,
  PartnerStatus,
  PrismaClient,
  RefundFinancialStatus,
  RefundScope,
  RefundStatus,
  SupportTicketCategory,
  SupportTicketPriority,
  UserRole,
} from "@prisma/client";
import { loadEnv } from "./config/env.js";
import { createPrismaStores } from "./lib/repositories.js";
import { createQueueInfrastructure, type QueueInfrastructure } from "./lib/redis.js";
import { buildApp } from "./app.js";
import { AttributionService } from "./services/attribution.js";
import { OrderService } from "./services/order.js";
import { InventoryService } from "./services/inventory.js";
import { CommissionService } from "./services/commission.js";
import { NotificationService } from "./services/notification.js";
import { VerificationService } from "./services/verification.js";
import { OperationsService } from "./services/operations.js";
import { SupportService } from "./services/support.js";
import { AnalyticsService } from "./services/analytics.js";

const runInfra = process.env.RUN_INFRA_TESTS === "true";

test("Phase 7 Business Operations & Order Management", { skip: !runInfra }, async (t) => {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const stores = createPrismaStores(prisma);
  const queues: QueueInfrastructure = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);

  const app = await buildApp({
    env,
    authStore: stores.authStore,
    auditStore: stores.auditStore,
    platformStore: stores.platformStore,
    queues,
    prisma,
    attributionService: new AttributionService(prisma, env.SESSION_SECRET),
    orderService: new OrderService(prisma),
    inventoryService: new InventoryService(prisma),
    verificationService: new VerificationService(
      prisma,
      new CommissionService(prisma),
      new NotificationService(prisma)
    ),
    notificationService: new NotificationService(prisma),
    operationsService: new OperationsService(prisma, env.DISBURSEMENT_ENABLED),
    supportService: new SupportService(prisma),
    analyticsService: new AnalyticsService(prisma),
    checkDb: async () => true,
  });

  const tag = `p7-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const password = "Phase7!Password123";
  const passwordHash = await hashPassword(password);

  let ownerUserId = "";
  let opsUserId = "";
  let partnerUserId = "";
  let customer1UserId = "";
  let customer2UserId = "";
  let partnerId = "";
  let customer1Id = "";
  let customer2Id = "";
  let gameAccountId = "";
  let order1Id = "";
  let order2Id = "";
  const extraOrderIds: string[] = [];
  let ruleId = "";
  let ticketId = "";

  let ownerHeaders: Record<string, string> = {};
  let opsHeaders: Record<string, string> = {};
  let partnerHeaders: Record<string, string> = {};
  let customer1Headers: Record<string, string> = {};

  async function loginAs(email: string): Promise<Record<string, string>> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    assert.equal(res.statusCode, 200, `Login failed for ${email}: ${res.body}`);
    const setCookie = res.headers["set-cookie"];
    assert.ok(setCookie, "Expected set-cookie header");
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const cookieStr = cookies.map((c) => c.split(";")[0]).join("; ");
    const csrfPair = cookies
      .map((c) => c.split(";")[0])
      .find((kv) => kv.startsWith("bigola_csrf="));
    const csrf = csrfPair ? decodeURIComponent(csrfPair.split("=").slice(1).join("=")) : "";
    return {
      cookie: cookieStr,
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    };
  }

  before(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `${tag}-owner@bigola.test`,
        passwordHash,
        role: UserRole.OWNER,
        mfaEnabled: true,
      },
    });
    ownerUserId = owner.id;

    const ops = await prisma.user.create({
      data: {
        email: `${tag}-ops@bigola.test`,
        passwordHash,
        role: UserRole.OPS_ADMIN,
        canConfirmFulfilment: false,
      },
    });
    opsUserId = ops.id;

    const partnerUser = await prisma.user.create({
      data: { email: `${tag}-partner@bigola.test`, passwordHash, role: UserRole.PARTNER },
    });
    partnerUserId = partnerUser.id;

    const partner = await prisma.partner.create({
      data: {
        userId: partnerUserId,
        displayName: `Partner ${tag}`,
        referralCode: `${tag.toUpperCase()}REF`,
        status: PartnerStatus.ACTIVE,
      },
    });
    partnerId = partner.id;

    const c1User = await prisma.user.create({
      data: { email: `${tag}-cust1@bigola.test`, passwordHash, role: UserRole.CUSTOMER },
    });
    customer1UserId = c1User.id;

    const c1 = await prisma.customer.create({
      data: {
        userId: customer1UserId,
        fullName: "Phase7 Customer One",
        email: `${tag}-cust1@bigola.test`,
        lagoslifeUsername: `ll_${tag}_1`,
        attributedPartnerId: partnerId,
      },
    });
    customer1Id = c1.id;

    const c2User = await prisma.user.create({
      data: { email: `${tag}-cust2@bigola.test`, passwordHash, role: UserRole.CUSTOMER },
    });
    customer2UserId = c2User.id;

    const c2 = await prisma.customer.create({
      data: {
        userId: customer2UserId,
        fullName: "Phase7 Customer Two",
        email: `${tag}-cust2@bigola.test`,
        lagoslifeUsername: `ll_${tag}_2`,
      },
    });
    customer2Id = c2.id;

    const ga = await prisma.gameAccount.create({
      data: {
        slotCode: `P7-${tag.slice(-6).toUpperCase()}`,
        lagoslifeUsername: `vault_${tag}`,
        accountRole: GameAccountRole.MAIN_TREASURY,
        lastKnownBalance: "50000",
        logicalAllocationAmount: "50000",
        reservedForOrders: "10000",
        lastSyncedAt: new Date(),
      },
    });
    gameAccountId = ga.id;

    const rule = await prisma.commissionRule.create({
      data: {
        category: CustomerCategory.CATEGORY_A_PARTNER,
        status: "SUPERSEDED",
        partnerShareBps: 2500,
        ownerShareBps: 2500,
        configuredById: ownerUserId,
      },
    });
    ruleId = rule.id;

    // Order 1: ₦10,000 (1,000,000 kobo), 10,000 LagosLife, Partner ₦2,500 (250,000 kobo), Owner ₦2,500 (250,000 kobo)
    // Status READY_FOR_FULFILMENT with active reservation of 10,000
    const o1 = await prisma.order.create({
      data: {
        orderNumber: `ORD-${tag}-1`,
        paymentReference: `PAY-${tag}-1`,
        channel: OrderChannel.ONLINE,
        orderType: OrderType.RETAIL,
        status: OrderStatus.READY_FOR_FULFILMENT,
        refundFinancialStatus: RefundFinancialStatus.NONE,
        customerId: customer1Id,
        customerCategory: CustomerCategory.CATEGORY_A_PARTNER,
        partnerId,
        recipientLagoslifeUsername: `ll_${tag}_1`,
        gameAmountRequested: "10000",
        fulfilledAmount: "0",
        fiatAmountKobo: 1000000n,
        verifiedGrossFiatKobo: 1000000n,
        confirmedRefundedKobo: 0n,
        pricingSnapshot: { unitRateNairaPer1000: 1000 },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    order1Id = o1.id;

    await prisma.inventoryReservation.create({
      data: {
        orderId: order1Id,
        gameAccountId,
        amount: "10000",
        status: InventoryReservationStatus.ACTIVE,
      },
    });

    await prisma.paymentVerificationDecision.create({
      data: {
        orderId: order1Id,
        verifierUserId: ownerUserId,
        verifierRole: UserRole.OWNER,
        decision: "APPROVED",
        bankCreditAmountKobo: 1000000n,
        reason: "Phase7 test approved payment",
      },
    });

    const cr1 = await prisma.commissionRecord.create({
      data: {
        orderId: order1Id,
        partnerId,
        category: CustomerCategory.CATEGORY_A_PARTNER,
        ruleId,
        grossFiatKobo: 1000000n,
        partnerEntitlementKobo: 250000n,
        ownerEntitlementKobo: 250000n,
        settlementStatus: CommissionSettlementStatus.ACCRUED,
      },
    });

    await prisma.commissionLedgerEntry.create({
      data: {
        commissionRecordId: cr1.id,
        partnerId,
        entryType: "ACCRUAL",
        partnerDeltaKobo: 250000n,
        ownerDeltaKobo: 250000n,
        notes: "Initial Phase7 test commission",
      },
    });

    // Order 2: ₦4,000 (400,000 kobo), unattributed customer, for clamping test
    const o2 = await prisma.order.create({
      data: {
        orderNumber: `ORD-${tag}-2`,
        paymentReference: `PAY-${tag}-2`,
        channel: OrderChannel.OFFLINE_OWNER,
        orderType: OrderType.RETAIL,
        status: OrderStatus.READY_FOR_FULFILMENT,
        refundFinancialStatus: RefundFinancialStatus.NONE,
        customerId: customer2Id,
        customerCategory: CustomerCategory.CATEGORY_B_BIGOLA,
        recipientLagoslifeUsername: `ll_${tag}_2`,
        gameAmountRequested: "4000",
        fulfilledAmount: "0",
        fiatAmountKobo: 400000n,
        verifiedGrossFiatKobo: 400000n,
        confirmedRefundedKobo: 0n,
        pricingSnapshot: { unitRateNairaPer1000: 1000 },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    order2Id = o2.id;

    await prisma.paymentVerificationDecision.create({
      data: {
        orderId: order2Id,
        verifierUserId: ownerUserId,
        verifierRole: UserRole.OWNER,
        decision: "APPROVED",
        bankCreditAmountKobo: 400000n,
        reason: "Phase7 order 2 approved",
      },
    });

    const cr2 = await prisma.commissionRecord.create({
      data: {
        orderId: order2Id,
        category: CustomerCategory.CATEGORY_B_BIGOLA,
        ruleId,
        grossFiatKobo: 400000n,
        partnerEntitlementKobo: 0n,
        ownerEntitlementKobo: -10000n,
        settlementStatus: CommissionSettlementStatus.ACCRUED,
      },
    });

    // Negative commission balance on Order 2 to test zero-clamping
    await prisma.commissionLedgerEntry.create({
      data: {
        commissionRecordId: cr2.id,
        entryType: "REVERSAL",
        partnerDeltaKobo: 0n,
        ownerDeltaKobo: -10000n,
        notes: "Pre-existing negative adjustment for clamping test",
      },
    });

    ownerHeaders = await loginAs(`${tag}-owner@bigola.test`);
    await prisma.userSession.updateMany({
      where: { userId: ownerUserId },
      data: { mfaVerified: true },
    });
    opsHeaders = await loginAs(`${tag}-ops@bigola.test`);
    partnerHeaders = await loginAs(`${tag}-partner@bigola.test`);
    customer1Headers = await loginAs(`${tag}-cust1@bigola.test`);
  });

  after(async () => {
    const userIds = [ownerUserId, opsUserId, partnerUserId, customer1UserId, customer2UserId].filter(Boolean);
    const orderIds = [order1Id, order2Id, ...extraOrderIds].filter(Boolean);

    try {
      await prisma.notification.deleteMany({
        where: {
          OR: [
            ...(userIds.length ? [{ recipientUserId: { in: userIds } }] : []),
            ...(orderIds.length ? [{ orderId: { in: orderIds } }] : []),
          ],
        },
      });
      await prisma.supportTicketMessage.deleteMany({
        where: ticketId ? { ticketId } : { authorUserId: { in: userIds } },
      });
      await prisma.supportTicket.deleteMany({
        where: { customerId: { in: [customer1Id, customer2Id].filter(Boolean) } },
      });
      if (orderIds.length) {
        await prisma.refundEvent.deleteMany({
          where: { refundRequest: { orderId: { in: orderIds } } },
        });
        await prisma.refundRequest.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.manualFulfilmentRecord.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.commissionLedgerEntry.deleteMany({
          where: { commissionRecord: { orderId: { in: orderIds } } },
        });
        await prisma.commissionRecord.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.paymentVerificationDecision.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.inventoryReservation.deleteMany({ where: { orderId: { in: orderIds } } });
      }
      if (ruleId) {
        await prisma.commissionRule.deleteMany({ where: { id: ruleId } });
      }
      if (gameAccountId) {
        await prisma.inventoryDiscrepancy.deleteMany({ where: { gameAccountId } });
        await prisma.inventoryLedger.deleteMany({ where: { gameAccountId } });
      }
      if (orderIds.length) {
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      if (gameAccountId) {
        await prisma.gameAccount.deleteMany({ where: { id: gameAccountId } });
      }
      const customerIds = [customer1Id, customer2Id].filter(Boolean);
      if (customerIds.length) {
        await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
      }
      if (partnerId) {
        await prisma.partner.deleteMany({ where: { id: partnerId } });
      }
      if (userIds.length) {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
        await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
    } catch (err) {
      console.error("[phase7.test] cleanup error:", err);
    } finally {
      await Promise.allSettled([app.close(), queues.close(), prisma.$disconnect()]);
    }
  });

  await t.test("1. RBAC isolation for OPS_ADMIN before & after fulfilment permission grant", async () => {
    // Without canConfirmFulfilment, OPS_ADMIN gets 403 on manual fulfilment
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/ops/orders/${order1Id}/confirm-fulfilment`,
      headers: opsHeaders,
      payload: {
        sourceGameAccountId: gameAccountId,
        deliveredAmount: "4000",
        externalReference: `EXT-${tag}-DENIED`,
        idempotencyKey: `IDEM-${tag}-DENIED`,
      },
    });
    assert.equal(denied.statusCode, 403);

    // Owner grants canConfirmFulfilment to OPS_ADMIN
    const grant = await app.inject({
      method: "PATCH",
      url: `/api/v1/owner/ops-admins/${opsUserId}/fulfilment-permission`,
      headers: ownerHeaders,
      payload: { canConfirmFulfilment: true, reason: "Authorized ops admin" },
    });
    assert.equal(grant.statusCode, 200, grant.body);
    assert.equal(grant.json().opsAdmin.canConfirmFulfilment, true);

    // OPS_ADMIN still gets 403 on Owner-only endpoints (analytics, audit-logs, refunds, verify)
    const ownerAnalytics = await app.inject({
      method: "GET",
      url: "/api/v1/owner/analytics",
      headers: opsHeaders,
    });
    assert.equal(ownerAnalytics.statusCode, 403);

    const ownerAudit = await app.inject({
      method: "GET",
      url: "/api/v1/owner/audit-logs",
      headers: opsHeaders,
    });
    assert.equal(ownerAudit.statusCode, 403);

    const ownerRefund = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${order1Id}/refunds`,
      headers: opsHeaders,
      payload: { scope: "PARTIAL", requestedAmountKobo: "100000", reason: "Unauthorized attempt" },
    });
    assert.equal(ownerRefund.statusCode, 403);
  });

  await t.test("2. Manual fulfilment idempotency, partial->fulfilled, inventory accounting & discrepancy", async () => {
    const idemKey1 = `IDEM-${tag}-1`;
    const extRef1 = `LL-${tag}-1`;

    // OPS_ADMIN (now authorized) performs partial fulfilment of 4,000 out of 10,000
    const res1 = await app.inject({
      method: "POST",
      url: `/api/v1/ops/orders/${order1Id}/confirm-fulfilment`,
      headers: opsHeaders,
      payload: {
        sourceGameAccountId: gameAccountId,
        deliveredAmount: "4000",
        externalReference: extRef1,
        idempotencyKey: idemKey1,
        notes: "First tranche",
      },
    });
    assert.equal(res1.statusCode, 201, res1.body);
    assert.equal(res1.json().order.status, "PARTIALLY_FULFILLED");
    assert.equal(res1.json().order.fulfilledAmount, "4000");

    // Same idempotencyKey + same payload -> 200 idempotent replay
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/ops/orders/${order1Id}/confirm-fulfilment`,
      headers: opsHeaders,
      payload: {
        sourceGameAccountId: gameAccountId,
        deliveredAmount: "4000",
        externalReference: extRef1,
        idempotencyKey: idemKey1,
        notes: "First tranche",
      },
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().idempotentReplay, true);

    // Same idempotencyKey + different payload -> 409 IDEMPOTENCY_CONFLICT
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/ops/orders/${order1Id}/confirm-fulfilment`,
      headers: opsHeaders,
      payload: {
        sourceGameAccountId: gameAccountId,
        deliveredAmount: "5000",
        externalReference: extRef1,
        idempotencyKey: idemKey1,
      },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, "IDEMPOTENCY_CONFLICT");

    // Exceeds remaining unfulfilled (6,000 left, try 7,000) -> 409 EXCEEDS_REMAINING_QUANTITY
    const overQty = await app.inject({
      method: "POST",
      url: `/api/v1/ops/orders/${order1Id}/confirm-fulfilment`,
      headers: opsHeaders,
      payload: {
        sourceGameAccountId: gameAccountId,
        deliveredAmount: "7000",
        externalReference: `LL-${tag}-OVER`,
        idempotencyKey: `IDEM-${tag}-OVER`,
      },
    });
    assert.equal(overQty.statusCode, 409);
    assert.equal(overQty.json().code, "EXCEEDS_REMAINING_QUANTITY");

    // Duplicate external reference with new idempotencyKey -> 409 DUPLICATE_FULFILMENT_REFERENCE
    const dupRef = await app.inject({
      method: "POST",
      url: `/api/v1/ops/orders/${order1Id}/confirm-fulfilment`,
      headers: opsHeaders,
      payload: {
        sourceGameAccountId: gameAccountId,
        deliveredAmount: "1000",
        externalReference: extRef1,
        idempotencyKey: `IDEM-${tag}-DUPREF`,
      },
    });
    assert.equal(dupRef.statusCode, 409);
    assert.equal(dupRef.json().code, "DUPLICATE_FULFILMENT_REFERENCE");

    // Complete remaining 6,000
    const res2 = await app.inject({
      method: "POST",
      url: `/api/v1/ops/orders/${order1Id}/confirm-fulfilment`,
      headers: opsHeaders,
      payload: {
        sourceGameAccountId: gameAccountId,
        deliveredAmount: "6000",
        externalReference: `LL-${tag}-2`,
        idempotencyKey: `IDEM-${tag}-2`,
      },
    });
    assert.equal(res2.statusCode, 201);
    assert.equal(res2.json().order.status, "COMPLETED");
    assert.equal(res2.json().order.fulfilledAmount, "10000");

    // Verify GameAccount.lastKnownBalance is STILL 50,000 while expectedBalance is 40,000
    const acctAfter = await prisma.gameAccount.findUnique({ where: { id: gameAccountId } });
    assert.equal(acctAfter?.lastKnownBalance.toFixed(0), "50000");

    const invRes = await app.inject({
      method: "GET",
      url: "/api/v1/ops/inventory",
      headers: opsHeaders,
    });
    assert.equal(invRes.statusCode, 200);
    const slot = invRes.json().slots.find((a: { id: string }) => a.id === gameAccountId);
    assert.ok(slot);
    assert.equal(slot.observedBalance, "50000");
    assert.equal(slot.manualFulfilmentDebitsSinceSync, "10000");
    assert.equal(slot.expectedBalance, "40000");
    assert.equal(slot.reservedForOrders, "0");
    assert.equal(slot.netAvailableBalance, "40000");

    // Next sync reports 39,500 instead of expected 40,000 -> discrepancy (-500) detected
    const syncRes = await app.inject({
      method: "POST",
      url: "/api/v1/owner/inventory/sync",
      headers: ownerHeaders,
      payload: {
        slotCode: slot.slotCode,
        observedBalance: "39500",
        reason: "Manual vault check",
      },
    });
    assert.equal(syncRes.statusCode, 200, syncRes.body);
    assert.ok(syncRes.json().discrepancy);
    assert.equal(syncRes.json().discrepancy.deltaAmount, "-500");
  });

  await t.test("3. Partial refund proportional BigInt clawback (10,000 / 2,000 -> 500 + 500), append-only history & fulfilment preservation", async () => {
    // Request ₦2,000 (200,000 kobo) partial refund on fulfilled Order 1 (₦10,000 verified, ₦2,500 partner, ₦2,500 owner)
    const reqRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${order1Id}/refunds`,
      headers: ownerHeaders,
      payload: {
        scope: "PARTIAL",
        requestedAmountKobo: "200000",
        reason: "Customer partial refund test",
      },
    });
    assert.equal(reqRes.statusCode, 201, reqRes.body);
    const refundId = reqRes.json().refundRequest.id as string;
    assert.equal(reqRes.json().refundRequest.currentStatus, RefundStatus.REQUESTED);

    // Advance REQUESTED -> PENDING
    const advRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${order1Id}/refunds/${refundId}/advance`,
      headers: ownerHeaders,
      payload: { reason: "Queued for bank payout" },
    });
    assert.equal(advRes.statusCode, 200);
    assert.equal(advRes.json().refundRequest.currentStatus, RefundStatus.PENDING);

    // Confirm refund with idempotencyKey
    const confirmIdem = `REF-IDEM-${tag}-1`;
    const confirmPayload = {
      confirmedAmountKobo: "200000",
      refundReference: `OPAY-REF-${tag}-1`,
      idempotencyKey: confirmIdem,
      reason: "Partial refund transferred",
    };

    const confRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${order1Id}/refunds/${refundId}/confirm`,
      headers: ownerHeaders,
      payload: confirmPayload,
    });
    assert.equal(confRes.statusCode, 200, confRes.body);
    assert.equal(confRes.json().idempotentReplay, false);

    // Verify zero-clamped proportional BigInt clawback (-₦500 partner, -₦500 owner)
    const clawbackEntries = await prisma.commissionLedgerEntry.findMany({
      where: {
        commissionRecord: { orderId: order1Id },
        entryType: "PARTIAL_REFUND_ADJUSTMENT",
      },
    });
    assert.equal(clawbackEntries.length, 1);
    assert.equal(clawbackEntries[0].partnerDeltaKobo, -50000n);
    assert.equal(clawbackEntries[0].ownerDeltaKobo, -50000n);

    // Idempotent replay -> 200
    const confReplay = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${order1Id}/refunds/${refundId}/confirm`,
      headers: ownerHeaders,
      payload: confirmPayload,
    });
    assert.equal(confReplay.statusCode, 200);
    assert.equal(confReplay.json().idempotentReplay, true);

    // Different idempotencyKey on already finalized refund -> 409 REFUND_ALREADY_FINALIZED
    const confAgain = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${order1Id}/refunds/${refundId}/confirm`,
      headers: ownerHeaders,
      payload: {
        ...confirmPayload,
        idempotencyKey: `REF-IDEM-${tag}-NEW`,
        refundReference: `OPAY-REF-${tag}-NEW`,
      },
    });
    assert.equal(confAgain.statusCode, 409);
    assert.equal(confAgain.json().code, "REFUND_ALREADY_FINALIZED");

    // Verify order1 still has COMPLETED status (currency not returned) and PARTIALLY_REFUNDED financial status
    const orderAfter = await prisma.order.findUnique({ where: { id: order1Id } });
    assert.equal(orderAfter?.status, OrderStatus.COMPLETED);
    assert.equal(orderAfter?.refundFinancialStatus, RefundFinancialStatus.PARTIALLY_REFUNDED);
    assert.equal(orderAfter?.confirmedRefundedKobo, 200000n);

    // Verify append-only RefundEvents (REQUESTED, PENDING, CONFIRMED = 3)
    const events = await prisma.refundEvent.findMany({
      where: { refundRequestId: refundId },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(
      events.map((e) => e.eventType),
      [RefundStatus.REQUESTED, RefundStatus.PENDING, RefundStatus.CONFIRMED]
    );
  });

  await t.test("4. Zero-clamped commission clawback when remaining balance is negative", async () => {
    const reqRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${order2Id}/refunds`,
      headers: ownerHeaders,
      payload: {
        scope: "FULL",
        requestedAmountKobo: "400000",
        reason: "Full refund on negative-balance order",
      },
    });
    assert.equal(reqRes.statusCode, 201);
    const refundId = reqRes.json().refundRequest.id as string;

    const confRes = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${order2Id}/refunds/${refundId}/confirm`,
      headers: ownerHeaders,
      payload: {
        confirmedAmountKobo: "400000",
        refundReference: `OPAY-REF-${tag}-2`,
        idempotencyKey: `REF-IDEM-${tag}-2`,
        reason: "Full refund settled",
      },
    });
    assert.equal(confRes.statusCode, 200, confRes.body);
    const o2Entries = await prisma.commissionLedgerEntry.findMany({
      where: { commissionRecord: { orderId: order2Id } },
    });
    const o2OwnerTotal = o2Entries.reduce((s, e) => s + e.ownerDeltaKobo, 0n);
    assert.equal(o2OwnerTotal, -10000n); // Clamped at 0n clawback (never went more negative)

    const order2After = await prisma.order.findUnique({ where: { id: order2Id } });
    assert.equal(order2After?.refundFinancialStatus, RefundFinancialStatus.FULLY_REFUNDED);
  });

  await t.test("5. Support tickets & strict internal-note privacy isolation", async () => {
    // Customer 1 creates a ticket
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/customer/support/tickets",
      headers: customer1Headers,
      payload: {
        orderId: order1Id,
        category: SupportTicketCategory.ORDER_DISPUTE,
        priority: SupportTicketPriority.HIGH,
        subject: "Delayed delivery check",
        body: "Please confirm my partial delivery reference.",
      },
    });
    assert.equal(createRes.statusCode, 201, createRes.body);
    ticketId = createRes.json().ticket.id;

    // Staff adds an INTERNAL note
    const internalNoteRes = await app.inject({
      method: "POST",
      url: `/api/v1/ops/support/tickets/${ticketId}/messages`,
      headers: opsHeaders,
      payload: {
        body: "SECRET_INTERNAL_RISK_NOTE: Check bank sender mismatch.",
        isInternal: true,
      },
    });
    assert.equal(internalNoteRes.statusCode, 201);

    // Staff adds a PUBLIC reply
    const publicReplyRes = await app.inject({
      method: "POST",
      url: `/api/v1/ops/support/tickets/${ticketId}/messages`,
      headers: opsHeaders,
      payload: {
        body: "Your transfer is confirmed and delivery is complete.",
        isInternal: false,
      },
    });
    assert.equal(publicReplyRes.statusCode, 201);

    // Customer reads ticket -> must NOT see SECRET_INTERNAL_RISK_NOTE
    const custRead = await app.inject({
      method: "GET",
      url: `/api/v1/customer/support/tickets/${ticketId}`,
      headers: customer1Headers,
    });
    assert.equal(custRead.statusCode, 200);
    const custBodies = custRead.json().ticket.messages.map((m: { body: string }) => m.body);
    assert.equal(custBodies.some((b: string) => b.includes("SECRET_INTERNAL_RISK_NOTE")), false);
    assert.equal(custBodies.length, 2);

    // Attributed Partner reads ticket -> must NOT see SECRET_INTERNAL_RISK_NOTE
    const partnerRead = await app.inject({
      method: "GET",
      url: `/api/v1/partner/support/tickets/${ticketId}`,
      headers: partnerHeaders,
    });
    assert.equal(partnerRead.statusCode, 200);
    const partnerBodies = partnerRead.json().ticket.messages.map((m: { body: string }) => m.body);
    assert.equal(partnerBodies.some((b: string) => b.includes("SECRET_INTERNAL_RISK_NOTE")), false);

    // Staff reads ticket -> DOES see internal note
    const opsRead = await app.inject({
      method: "GET",
      url: `/api/v1/ops/support/tickets/${ticketId}`,
      headers: opsHeaders,
    });
    assert.equal(opsRead.statusCode, 200);
    const opsBodies = opsRead.json().ticket.messages.map((m: { body: string }) => m.body);
    assert.equal(opsBodies.some((b: string) => b.includes("SECRET_INTERNAL_RISK_NOTE")), true);
  });

  await t.test("6. Owner analytics reversal & refund awareness + Partner analytics", async () => {
    const ownerAna = await app.inject({
      method: "GET",
      url: "/api/v1/owner/analytics",
      headers: ownerHeaders,
    });
    assert.equal(ownerAna.statusCode, 200, ownerAna.body);
    const summary = ownerAna.json().summary;
    // Net verified revenue must be <= approvedDecisions - confirmedRefunds (never raw unallocated statement lines)
    assert.ok(BigInt(summary.confirmedRefundsKobo) >= 600000n);
    assert.ok(BigInt(summary.approvedDecisionsKobo) >= 1400000n);

    const partnerAna = await app.inject({
      method: "GET",
      url: "/api/v1/partner/analytics?days=30",
      headers: partnerHeaders,
    });
    assert.equal(partnerAna.statusCode, 200, partnerAna.body);
    assert.ok(BigInt(partnerAna.json().analytics.netCommissionKobo) >= 200000n);
  });

  await t.test("7. Concurrent & sequential refund confirmation idempotency, conflict, finalization & gross cap safety", async () => {
    const o3 = await prisma.order.create({
      data: {
        orderNumber: `ORD-${tag}-3`,
        paymentReference: `PAY-${tag}-3`,
        channel: OrderChannel.ONLINE,
        orderType: OrderType.RETAIL,
        status: OrderStatus.READY_FOR_FULFILMENT,
        refundFinancialStatus: RefundFinancialStatus.NONE,
        customerId: customer1Id,
        customerCategory: CustomerCategory.CATEGORY_A_PARTNER,
        partnerId,
        recipientLagoslifeUsername: `ll_${tag}_3`,
        gameAmountRequested: "10000",
        fulfilledAmount: "0",
        fiatAmountKobo: 1000000n,
        verifiedGrossFiatKobo: 1000000n,
        confirmedRefundedKobo: 0n,
        pricingSnapshot: { unitRateNairaPer1000: 1000 },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    extraOrderIds.push(o3.id);

    const cr3 = await prisma.commissionRecord.create({
      data: {
        orderId: o3.id,
        partnerId,
        category: CustomerCategory.CATEGORY_A_PARTNER,
        ruleId,
        grossFiatKobo: 1000000n,
        partnerEntitlementKobo: 250000n,
        ownerEntitlementKobo: 250000n,
        settlementStatus: CommissionSettlementStatus.ACCRUED,
      },
    });
    await prisma.commissionLedgerEntry.create({
      data: {
        commissionRecordId: cr3.id,
        partnerId,
        entryType: "ACCRUAL",
        partnerDeltaKobo: 250000n,
        ownerDeltaKobo: 250000n,
        notes: "Initial commission for refund idempotency test",
      },
    });

    const reqA = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${o3.id}/refunds`,
      headers: ownerHeaders,
      payload: { scope: "PARTIAL", requestedAmountKobo: "600000", reason: "Refund A for idempotency checks" },
    });
    assert.equal(reqA.statusCode, 201);
    const refAId = reqA.json().refundRequest.id as string;

    const confirmPayloadA = {
      confirmedAmountKobo: "600000",
      refundReference: `OPAY-CONC-A-${tag}`,
      idempotencyKey: `IDEM-CONC-A-${tag}`,
      reason: "Confirm A idempotent",
    };

    // (a) Concurrent identical retries -> one confirmation, both callers receive HTTP 200 with the original confirmed result
    const [concRetry1, concRetry2] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${o3.id}/refunds/${refAId}/confirm`,
        headers: ownerHeaders,
        payload: confirmPayloadA,
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${o3.id}/refunds/${refAId}/confirm`,
        headers: ownerHeaders,
        payload: confirmPayloadA,
      }),
    ]);
    assert.equal(concRetry1.statusCode, 200, concRetry1.body);
    assert.equal(concRetry2.statusCode, 200, concRetry2.body);

    const body1 = concRetry1.json();
    const body2 = concRetry2.json();
    assert.deepEqual(
      [body1.idempotentReplay, body2.idempotentReplay].sort(),
      [false, true],
      "Exactly one caller should perform the initial confirmation and the concurrent caller should receive the idempotent replay"
    );
    for (const b of [body1, body2]) {
      assert.equal(b.refundRequest.id, refAId);
      assert.equal(b.refundRequest.currentStatus, "CONFIRMED");
      assert.equal(b.refundRequest.confirmedRefundReference, `OPAY-CONC-A-${tag}`);
      assert.equal(b.order.id, o3.id);
      assert.equal(b.order.confirmedRefundedKobo, "600000");
    }

    // (b) Sequential identical retry after successful confirmation -> HTTP 200 returning original confirmed refund
    const seqRetry = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${o3.id}/refunds/${refAId}/confirm`,
      headers: ownerHeaders,
      payload: confirmPayloadA,
    });
    assert.equal(seqRetry.statusCode, 200, seqRetry.body);
    const seqBody = seqRetry.json();
    assert.equal(seqBody.idempotentReplay, true);
    assert.equal(seqBody.refundRequest.id, refAId);
    assert.equal(seqBody.refundRequest.currentStatus, "CONFIRMED");
    assert.equal(seqBody.refundRequest.confirmedRefundReference, `OPAY-CONC-A-${tag}`);
    assert.equal(seqBody.order.confirmedRefundedKobo, "600000");

    // (c) Same key with different payload -> HTTP 409 IDEMPOTENCY_CONFLICT
    const conflictRetry = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${o3.id}/refunds/${refAId}/confirm`,
      headers: ownerHeaders,
      payload: {
        ...confirmPayloadA,
        confirmedAmountKobo: "500000",
      },
    });
    assert.equal(conflictRetry.statusCode, 409, conflictRetry.body);
    assert.equal(conflictRetry.json().code, "IDEMPOTENCY_CONFLICT");

    // (d) Different confirmation key against already finalized refund -> HTTP 409 REFUND_ALREADY_FINALIZED
    const diffKeyFinalized = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${o3.id}/refunds/${refAId}/confirm`,
      headers: ownerHeaders,
      payload: {
        confirmedAmountKobo: "600000",
        refundReference: `OPAY-DIFF-KEY-${tag}`,
        idempotencyKey: `IDEM-DIFF-KEY-${tag}`,
        reason: "Different key after finalization",
      },
    });
    assert.equal(diffKeyFinalized.statusCode, 409, diffKeyFinalized.body);
    assert.equal(diffKeyFinalized.json().code, "REFUND_ALREADY_FINALIZED");

    // Verify o3 state: exactly 1 CONFIRMED RefundEvent and no duplicate commission adjustments
    const o3After = await prisma.order.findUniqueOrThrow({ where: { id: o3.id } });
    assert.equal(o3After.confirmedRefundedKobo, 600000n);
    assert.ok(o3After.confirmedRefundedKobo <= o3After.verifiedGrossFiatKobo);

    const confirmedEvents = await prisma.refundEvent.findMany({
      where: { orderId: o3.id, eventType: RefundStatus.CONFIRMED },
    });
    assert.equal(confirmedEvents.length, 1);

    const ledgerEntries = await prisma.commissionLedgerEntry.findMany({
      where: { commissionRecordId: cr3.id },
    });
    // 1 ACCRUAL + 1 PARTIAL_REFUND_ADJUSTMENT (-150,000 partner, -150,000 owner)
    assert.equal(ledgerEntries.length, 2);
    const partnerNet = ledgerEntries.reduce((s, e) => s + e.partnerDeltaKobo, 0n);
    const ownerNet = ledgerEntries.reduce((s, e) => s + e.ownerDeltaKobo, 0n);
    assert.equal(partnerNet, 100000n);
    assert.equal(ownerNet, 100000n);

    // (e) Two competing separate ₦6,000 refund confirmations racing against a ₦10,000 verified order
    const o3Cap = await prisma.order.create({
      data: {
        orderNumber: `ORD-${tag}-3C`,
        paymentReference: `PAY-${tag}-3C`,
        channel: OrderChannel.ONLINE,
        orderType: OrderType.RETAIL,
        status: OrderStatus.READY_FOR_FULFILMENT,
        refundFinancialStatus: RefundFinancialStatus.NONE,
        customerId: customer1Id,
        customerCategory: CustomerCategory.CATEGORY_A_PARTNER,
        partnerId,
        recipientLagoslifeUsername: `ll_${tag}_3c`,
        gameAmountRequested: "10000",
        fulfilledAmount: "0",
        fiatAmountKobo: 1000000n,
        verifiedGrossFiatKobo: 1000000n,
        confirmedRefundedKobo: 0n,
        pricingSnapshot: { unitRateNairaPer1000: 1000 },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    extraOrderIds.push(o3Cap.id);

    const reqCompete1 = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${o3Cap.id}/refunds`,
      headers: ownerHeaders,
      payload: { scope: "PARTIAL", requestedAmountKobo: "600000", reason: "Competing refund 1" },
    });
    assert.equal(reqCompete1.statusCode, 201);
    const compete1Id = reqCompete1.json().refundRequest.id as string;

    const reqCompete2 = await app.inject({
      method: "POST",
      url: `/api/v1/owner/orders/${o3Cap.id}/refunds`,
      headers: ownerHeaders,
      payload: { scope: "PARTIAL", requestedAmountKobo: "600000", reason: "Competing refund 2" },
    });
    assert.equal(reqCompete2.statusCode, 201);
    const compete2Id = reqCompete2.json().refundRequest.id as string;

    const [compRes1, compRes2] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${o3Cap.id}/refunds/${compete1Id}/confirm`,
        headers: ownerHeaders,
        payload: {
          confirmedAmountKobo: "600000",
          refundReference: `OPAY-COMP-1-${tag}`,
          idempotencyKey: `IDEM-COMP-1-${tag}`,
          reason: "Confirm competing 1",
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${o3Cap.id}/refunds/${compete2Id}/confirm`,
        headers: ownerHeaders,
        payload: {
          confirmedAmountKobo: "600000",
          refundReference: `OPAY-COMP-2-${tag}`,
          idempotencyKey: `IDEM-COMP-2-${tag}`,
          reason: "Confirm competing 2",
        },
      }),
    ]);
    assert.deepEqual(
      [compRes1.statusCode, compRes2.statusCode].sort(),
      [200, 409],
      `Expected [200, 409], got 1=${compRes1.statusCode}:${compRes1.body} 2=${compRes2.statusCode}:${compRes2.body}`
    );
    const compLoser = compRes1.statusCode === 409 ? compRes1 : compRes2;
    assert.equal(compLoser.json().code, "REFUND_EXCEEDS_VERIFIED_PAYMENT");

    const o3CapEvents = await prisma.refundEvent.findMany({
      where: { orderId: o3Cap.id, eventType: RefundStatus.CONFIRMED },
    });
    assert.equal(o3CapEvents.length, 1);
  });

  await t.test("8. Concurrent manual fulfilment prevents over-fulfilment, negative expected balance & double debit", async () => {
    // Remaining expectedBalance on gameAccountId is 40,000 (after 10,000 fulfilled & 39,500 synced in Test 2 -> synced at 39,500)
    // Sync gameAccountId cleanly to 5,000 for an exact boundary test
    const syncExact = await app.inject({
      method: "POST",
      url: "/api/v1/owner/inventory/sync",
      headers: ownerHeaders,
      payload: {
        slotCode: `P7-${tag.slice(-6).toUpperCase()}`,
        observedBalance: "5000",
        reason: "Exact 5,000 balance for concurrent fulfilment test",
      },
    });
    assert.equal(syncExact.statusCode, 200, syncExact.body);

    const o4 = await prisma.order.create({
      data: {
        orderNumber: `ORD-${tag}-4`,
        paymentReference: `PAY-${tag}-4`,
        channel: OrderChannel.ONLINE,
        orderType: OrderType.RETAIL,
        status: OrderStatus.READY_FOR_FULFILMENT,
        refundFinancialStatus: RefundFinancialStatus.NONE,
        customerId: customer1Id,
        customerCategory: CustomerCategory.CATEGORY_A_PARTNER,
        partnerId,
        recipientLagoslifeUsername: `ll_${tag}_4`,
        gameAmountRequested: "5000",
        fulfilledAmount: "0",
        fiatAmountKobo: 500000n,
        verifiedGrossFiatKobo: 500000n,
        confirmedRefundedKobo: 0n,
        pricingSnapshot: { unitRateNairaPer1000: 1000 },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    extraOrderIds.push(o4.id);

    await prisma.inventoryReservation.create({
      data: {
        orderId: o4.id,
        gameAccountId,
        amount: "5000",
        status: InventoryReservationStatus.ACTIVE,
      },
    });
    await prisma.gameAccount.update({
      where: { id: gameAccountId },
      data: { reservedForOrders: "5000" },
    });

    // Fire two parallel 3,000-unit fulfilments against 5,000-unit order (only one 3,000 can fit!)
    const [f1, f2] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/ops/orders/${o4.id}/confirm-fulfilment`,
        headers: opsHeaders,
        payload: {
          sourceGameAccountId: gameAccountId,
          deliveredAmount: "3000",
          externalReference: `CONC-FUL-1-${tag}`,
          idempotencyKey: `IDEM-FUL-1-${tag}`,
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/ops/orders/${o4.id}/confirm-fulfilment`,
        headers: opsHeaders,
        payload: {
          sourceGameAccountId: gameAccountId,
          deliveredAmount: "3000",
          externalReference: `CONC-FUL-2-${tag}`,
          idempotencyKey: `IDEM-FUL-2-${tag}`,
        },
      }),
    ]);

    const fulStatuses = [f1.statusCode, f2.statusCode].sort();
    assert.deepEqual(fulStatuses, [201, 409], `Expected [201, 409], got f1=${f1.statusCode}:${f1.body} f2=${f2.statusCode}:${f2.body}`);
    const loserFul = f1.statusCode === 409 ? f1 : f2;
    assert.equal(loserFul.json().code, "EXCEEDS_REMAINING_QUANTITY");

    // Fire two parallel idempotent replays with the same key/payload -> neither may double-debit
    const winnerPayload =
      f1.statusCode === 201
        ? { sourceGameAccountId: gameAccountId, deliveredAmount: "3000", externalReference: `CONC-FUL-1-${tag}`, idempotencyKey: `IDEM-FUL-1-${tag}` }
        : { sourceGameAccountId: gameAccountId, deliveredAmount: "3000", externalReference: `CONC-FUL-2-${tag}`, idempotencyKey: `IDEM-FUL-2-${tag}` };

    const [rep1, rep2] = await Promise.all([
      app.inject({ method: "POST", url: `/api/v1/ops/orders/${o4.id}/confirm-fulfilment`, headers: opsHeaders, payload: winnerPayload }),
      app.inject({ method: "POST", url: `/api/v1/ops/orders/${o4.id}/confirm-fulfilment`, headers: opsHeaders, payload: winnerPayload }),
    ]);
    assert.equal(rep1.statusCode, 200);
    assert.equal(rep2.statusCode, 200);
    assert.equal(rep1.json().idempotentReplay, true);
    assert.equal(rep2.json().idempotentReplay, true);

    const o4Mid = await prisma.order.findUniqueOrThrow({ where: { id: o4.id } });
    assert.equal(o4Mid.fulfilledAmount.toFixed(0), "3000");

    const invMid = await app.inject({ method: "GET", url: "/api/v1/ops/inventory", headers: opsHeaders });
    const slotMid = invMid.json().slots.find((s: { id: string }) => s.id === gameAccountId);
    assert.equal(slotMid.expectedBalance, "2000");
    assert.equal(slotMid.reservedForOrders, "2000");
    assert.ok(BigInt(slotMid.expectedBalance) >= 0n);

    const debits = await prisma.inventoryLedger.findMany({
      where: { orderId: o4.id },
    });
    assert.equal(debits.length, 1);
  });

  await t.test("9. Sequential partial refunds + final refund deterministic integer-kobo clawback", async () => {
    const o5 = await prisma.order.create({
      data: {
        orderNumber: `ORD-${tag}-5`,
        paymentReference: `PAY-${tag}-5`,
        channel: OrderChannel.ONLINE,
        orderType: OrderType.RETAIL,
        status: OrderStatus.COMPLETED,
        refundFinancialStatus: RefundFinancialStatus.NONE,
        customerId: customer1Id,
        customerCategory: CustomerCategory.CATEGORY_A_PARTNER,
        partnerId,
        recipientLagoslifeUsername: `ll_${tag}_5`,
        gameAmountRequested: "10000",
        fulfilledAmount: "10000",
        fiatAmountKobo: 1000000n,
        verifiedGrossFiatKobo: 1000000n,
        confirmedRefundedKobo: 0n,
        pricingSnapshot: { unitRateNairaPer1000: 1000 },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    extraOrderIds.push(o5.id);

    const cr5 = await prisma.commissionRecord.create({
      data: {
        orderId: o5.id,
        partnerId,
        category: CustomerCategory.CATEGORY_A_PARTNER,
        ruleId,
        grossFiatKobo: 1000000n,
        partnerEntitlementKobo: 250000n,
        ownerEntitlementKobo: 250000n,
        settlementStatus: CommissionSettlementStatus.ACCRUED,
      },
    });
    await prisma.commissionLedgerEntry.create({
      data: {
        commissionRecordId: cr5.id,
        partnerId,
        entryType: "ACCRUAL",
        partnerDeltaKobo: 250000n,
        ownerDeltaKobo: 250000n,
        notes: "Initial commission for sequential partial refund rounding test",
      },
    });

    const tranches = [
      { scope: "PARTIAL", amount: "333333", label: "seq-1" },
      { scope: "PARTIAL", amount: "333333", label: "seq-2" },
      { scope: "FULL", amount: "333334", label: "seq-final" },
    ] as const;

    for (const tr of tranches) {
      const rq = await app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${o5.id}/refunds`,
        headers: ownerHeaders,
        payload: { scope: tr.scope, requestedAmountKobo: tr.amount, reason: `Sequential ${tr.label}` },
      });
      assert.equal(rq.statusCode, 201, rq.body);
      const rid = rq.json().refundRequest.id as string;

      const cf = await app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${o5.id}/refunds/${rid}/confirm`,
        headers: ownerHeaders,
        payload: {
          confirmedAmountKobo: tr.amount,
          refundReference: `OPAY-${tr.label}-${tag}`,
          idempotencyKey: `IDEM-${tr.label}-${tag}`,
          reason: `Confirm ${tr.label}`,
        },
      });
      assert.equal(cf.statusCode, 200, cf.body);
    }

    const o5After = await prisma.order.findUniqueOrThrow({ where: { id: o5.id } });
    assert.equal(o5After.confirmedRefundedKobo, 1000000n);
    assert.equal(o5After.refundFinancialStatus, RefundFinancialStatus.FULLY_REFUNDED);
    assert.equal(o5After.status, OrderStatus.COMPLETED);

    const entries = await prisma.commissionLedgerEntry.findMany({
      where: { commissionRecordId: cr5.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(entries.length, 4); // 1 ACCRUAL + 3 clawbacks (83333, 83333, 83334)
    const partnerClawbacks = entries.slice(1).map((e) => e.partnerDeltaKobo);
    const ownerClawbacks = entries.slice(1).map((e) => e.ownerDeltaKobo);
    assert.deepEqual(partnerClawbacks, [-83333n, -83333n, -83334n]);
    assert.deepEqual(ownerClawbacks, [-83333n, -83333n, -83334n]);

    const netPartner = entries.reduce((s, e) => s + e.partnerDeltaKobo, 0n);
    const netOwner = entries.reduce((s, e) => s + e.ownerDeltaKobo, 0n);
    assert.equal(netPartner, 0n);
    assert.equal(netOwner, 0n);
  });
});
