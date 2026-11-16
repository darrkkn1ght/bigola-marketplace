import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CustomerCategory,
  GameAccountHealth,
  GameAccountRole,
  PartnerStatus,
  PrismaClient,
  UserRole,
} from "@prisma/client";
import { buildWhatsAppReceiptUrl, ONE_TRILLION } from "@bigola/shared";
import { buildApp } from "./app.js";
import { loadIsolatedTestEnv } from "./lib/test-isolation.js";
import { encryptSensitiveValue, generateTotpCode, hashPassword } from "./lib/crypto.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import { createPrismaStores } from "./lib/repositories.js";
import { AttributionService } from "./services/attribution.js";
import { CommissionService } from "./services/commission.js";
import { DisbursementService } from "./services/disbursement.js";
import { InventoryService } from "./services/inventory.js";
import type { LagosLifeAdapter } from "./services/lagoslife.js";
import { NotificationService } from "./services/notification.js";
import { OrderService } from "./services/order.js";
import { VerificationService } from "./services/verification.js";

const RUN_INFRA = process.env.RUN_INFRA_TESTS === "true";

describe("UX Simplification & Automation Sprint (P0 & P1)", { skip: !RUN_INFRA }, () => {
  it("enforces mandatory referral, configurable min/max (>240T), WhatsApp instructions, one-click confirm-and-deliver, and safe inventory sync", async () => {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Refusing integration tests against NODE_ENV=production.");
    }

    const env = loadIsolatedTestEnv();
    assert.equal(env.DISBURSEMENT_ENABLED, false);
    const prisma = new PrismaClient();
    const stores = createPrismaStores(prisma);
    const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);
    const attributionService = new AttributionService(prisma, env.SESSION_SECRET);
    const orderService = new OrderService(prisma);
    const inventoryService = new InventoryService(prisma, {
      encryptionKeyHex: env.ENCRYPTION_KEY_HEX,
    });
    const commissionService = new CommissionService(prisma);
    const notificationService = new NotificationService(prisma);
    const verificationService = new VerificationService(prisma, commissionService, notificationService);
    const mockAdapter = {
      resolveTargetIdAsync: async (username: string) => ({
        id: `mock_uid_${username}`,
        username,
        name: username,
      }),
    } as unknown as LagosLifeAdapter;
    const disbursementService = new DisbursementService(
      prisma,
      env.ENCRYPTION_KEY_HEX,
      mockAdapter,
      { redis: queues.redis, disbursementEnabled: false }
    );

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
      disbursementService,
      checkDb: async () => true,
    });

    const runId = Date.now().toString(36);
    const originalBulkPricing = await prisma.platformSetting.findUnique({ where: { key: "bulk_pricing" } });
    const originalBizSettings = await prisma.platformSetting.findUnique({ where: { key: "business_settings" } });
    const originalReserve1 = await prisma.gameAccount.findUnique({ where: { slotCode: "RESERVE_1" } });
    try {
      // 1. Seed Owner + Partner + ReceivingBankAccount + Fresh Inventory (> 250T)
      const ownerEmail = `owner-p0-${runId}@bigola.test`;
      const ownerPassword = "OwnerPassword123!";
      const ownerUser = await prisma.user.create({
        data: {
          email: ownerEmail,
          passwordHash: await hashPassword(ownerPassword),
          role: UserRole.OWNER,
          mfaEnabled: false,
          isActive: true,
        },
      });

      const partnerEmail = `partner-p0-${runId}@bigola.test`;
      const partnerUser = await prisma.user.create({
        data: {
          email: partnerEmail,
          passwordHash: await hashPassword("PartnerPass123!"),
          role: UserRole.PARTNER,
          isActive: true,
        },
      });
      const partnerCode = `BGO-P0-${runId.toUpperCase()}`;
      const partner = await prisma.partner.create({
        data: {
          userId: partnerUser.id,
          displayName: `Partner ${runId}`,
          referralCode: partnerCode,
          status: PartnerStatus.ACTIVE,
          canVerifyPayments: false,
        },
      });

      // Ensure an active receiving bank account exists
      const existingBank = await prisma.receivingBankAccount.findFirst({ where: { isActive: true } });
      if (!existingBank) {
        await prisma.receivingBankAccount.create({
          data: {
            bankName: "OPay",
            accountNumber: `90${runId.slice(-8).padStart(8, "0")}`,
            accountName: "Big Ola Test Account",
            isDefault: true,
            isActive: true,
            ownerPartnerId: partner.id,
            createdById: ownerUser.id,
          },
        });
      }

      // Login as Owner & enable 2FA
      const ownerLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: ownerEmail, password: ownerPassword },
      });
      assert.equal(ownerLogin.statusCode, 200);
      const ownerToken = (ownerLogin.json() as { token: string }).token;
      const setup2fa = await app.inject({
        method: "POST",
        url: "/api/v1/auth/2fa/setup",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(setup2fa.statusCode, 200);
      const enable2fa = await app.inject({
        method: "POST",
        url: "/api/v1/auth/2fa/enable",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { code: generateTotpCode((setup2fa.json() as { manualKey: string }).manualKey) },
      });
      assert.equal(enable2fa.statusCode, 200);

      // Ensure at least 300T fresh reserve inventory with an encrypted session bundle
      const testSessionBundle = encryptSensitiveValue(
        JSON.stringify({
          cookie: "ll_session=test_session_cookie",
          uid: `uid_${runId}`,
          username: `res1_${runId}`,
          simName: "Test Reserve 1",
          connectedAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          transactionPin: "1234",
        }),
        env.ENCRYPTION_KEY_HEX
      );
      const slotRes = await prisma.gameAccount.upsert({
        where: { slotCode: "RESERVE_1" },
        update: {
          healthStatus: GameAccountHealth.ACTIVE,
          lastKnownBalance: (350n * ONE_TRILLION).toString(),
          reservedForOrders: "0",
          lastSyncedAt: new Date(),
          encryptedSessionBundle: testSessionBundle,
        },
        create: {
          slotCode: "RESERVE_1",
          accountRole: GameAccountRole.RESERVE,
          lagoslifeUsername: `res1_${runId}`,
          healthStatus: GameAccountHealth.ACTIVE,
          lastKnownBalance: (350n * ONE_TRILLION).toString(),
          reservedForOrders: "0",
          lastSyncedAt: new Date(),
          encryptedSessionBundle: testSessionBundle,
        },
      });

      // Configure bulk pricing (min 5T, max 300T) and business settings with WhatsApp number
      const pricingRes = await app.inject({
        method: "PUT",
        url: "/api/v1/owner/pricing/bulk",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          priceKoboPerTrillion: "100000",
          minBulkGameAmount: (5n * ONE_TRILLION).toString(),
          maxBulkGameAmount: (300n * ONE_TRILLION).toString(),
          enabled: true,
          reason: "Test configurable min/max above 240T",
        },
      });
      assert.equal(pricingRes.statusCode, 200);

      const bizRes = await app.inject({
        method: "PUT",
        url: "/api/v1/owner/business-settings",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          marketplaceSalesEnabled: true,
          retailOrdersEnabled: true,
          bulkOrdersEnabled: true,
          whatsappNumber: "08012345678",
          reason: "Configure WhatsApp receipt number",
        },
      });
      assert.equal(bizRes.statusCode, 200);

      // P0.2: Mandatory referral code enforcement
      const missingRefRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: `noref-${runId}@bigola.test`,
          password: "CustomerPass123!",
          fullName: "No Ref User",
        },
      });
      assert.equal(missingRefRes.statusCode, 400);
      assert.equal((missingRefRes.json() as { code: string }).code, "REFERRAL_CODE_REQUIRED");

      const invalidRefRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: `badref-${runId}@bigola.test`,
          password: "CustomerPass123!",
          fullName: "Bad Ref User",
          referralCode: "INVALID-CODE-999",
        },
      });
      assert.equal(invalidRefRes.statusCode, 400);
      assert.equal((invalidRefRes.json() as { code: string }).code, "INVALID_REFERRAL_CODE");

      const selfRefRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: partnerEmail,
          password: "CustomerPass123!",
          fullName: "Self Ref User",
          referralCode: partnerCode,
        },
      });
      assert.equal(selfRefRes.statusCode, 400);
      assert.equal((selfRefRes.json() as { code: string }).code, "SELF_REFERRAL_NOT_ALLOWED");

      const custEmail = `cust-p0-${runId}@bigola.test`;
      const custPass = "CustomerPass123!";
      const validRegRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: custEmail,
          password: custPass,
          fullName: "Valid Customer",
          lagoslifeUsername: `llcust_${runId}`,
          referralCode: partnerCode,
        },
      });
      assert.equal(validRegRes.statusCode, 201);
      const regJson = validRegRes.json() as {
        customer: { category: string; attributedPartnerId: string };
      };
      assert.equal(regJson.customer.category, CustomerCategory.CATEGORY_A_PARTNER);
      assert.equal(regJson.customer.attributedPartnerId, partner.id);

      const custLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: custEmail, password: custPass },
      });
      assert.equal(custLogin.statusCode, 200);
      const custToken = (custLogin.json() as { token: string }).token;

      // P0.1: Enforce configurable min/max (>240T allowed when configured to 300T)
      const underMinRes = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: { authorization: `Bearer ${custToken}`, "idempotency-key": `min-${runId}` },
        payload: {
          orderType: "BULK",
          gameAmount: (4n * ONE_TRILLION).toString(),
          recipientLagoslifeUsername: `target_${runId}`,
        },
      });
      assert.equal(underMinRes.statusCode, 400);

      const overMaxRes = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: { authorization: `Bearer ${custToken}`, "idempotency-key": `max-${runId}` },
        payload: {
          orderType: "BULK",
          gameAmount: (301n * ONE_TRILLION).toString(),
          recipientLagoslifeUsername: `target_${runId}`,
        },
      });
      assert.equal(overMaxRes.statusCode, 400);

      // 250T order succeeds (proves no 240T hardcoded limit!)
      const order250Res = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: { authorization: `Bearer ${custToken}`, "idempotency-key": `ok250-${runId}` },
        payload: {
          orderType: "BULK",
          gameAmount: (250n * ONE_TRILLION).toString(),
          recipientLagoslifeUsername: `target_${runId}`,
        },
      });
      assert.equal(order250Res.statusCode, 201);
      const order250 = (order250Res.json() as { order: { id: string } }).order;

      // P0.3: Payment instructions include WhatsApp number
      const instrRes = await app.inject({
        method: "GET",
        url: `/api/v1/orders/${order250.id}/payment-instructions`,
        headers: { authorization: `Bearer ${custToken}` },
      });
      assert.equal(instrRes.statusCode, 200);
      const instrJson = instrRes.json() as { whatsappNumber: string | null; receivingAccounts: unknown[] };
      assert.equal(instrJson.whatsappNumber, "08012345678");
      assert.ok(instrJson.receivingAccounts.length >= 1);

      // Create a smaller 5T order for one-click confirm-and-deliver + idempotency + duplicate ref check
      const order1Res = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: { authorization: `Bearer ${custToken}`, "idempotency-key": `ok1-${runId}` },
        payload: {
          orderType: "BULK",
          gameAmount: (5n * ONE_TRILLION).toString(),
          recipientLagoslifeUsername: `target1_${runId}`,
        },
      });
      assert.equal(order1Res.statusCode, 201);
      const order1 = (order1Res.json() as { order: { id: string } }).order;

      // P0.4: One-click confirm-and-deliver
      const bankRef = `OPAY-REF-${runId.toUpperCase()}`;
      const confirmRes = await app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${order1.id}/confirm-and-deliver`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { bankCreditReference: bankRef },
      });
      assert.equal(confirmRes.statusCode, 200, `confirm-and-deliver failed: ${confirmRes.body}`);
      const confirmJson = confirmRes.json() as {
        idempotent: boolean;
        orderStatus: string;
        job: { id: string; totalChunks: number };
      };
      assert.equal(confirmJson.idempotent, false);
      assert.equal(confirmJson.orderStatus, "QUEUED");
      assert.equal(confirmJson.job.totalChunks, 50); // 5T = 50 * 100B chunks

      // Idempotent second call
      const confirmAgainRes = await app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${order1.id}/confirm-and-deliver`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { bankCreditReference: bankRef },
      });
      assert.equal(confirmAgainRes.statusCode, 200);
      const confirmAgainJson = confirmAgainRes.json() as {
        idempotent: boolean;
        job: { id: string };
      };
      assert.equal(confirmAgainJson.idempotent, true);
      assert.equal(confirmAgainJson.job.id, confirmJson.job.id);

      // Duplicate bank reference on order250 must be rejected
      const dupRefRes = await app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${order250.id}/confirm-and-deliver`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { bankCreditReference: bankRef },
      });
      assert.equal(dupRefRes.statusCode, 409);

      // P1: InventoryService.syncAllLiveBalances skips accounts with IN_FLIGHT chunks
      await prisma.disbursementChunk.create({
        data: {
          jobId: confirmJson.job.id,
          sourceAccountId: slotRes.id,
          recipientUsername: `inflight_${runId}`,
          amount: "100000000000",
          idempotencyKey: `inflight-chunk-${runId}`,
          status: "IN_FLIGHT",
        },
      });
      const syncOut = await inventoryService.syncAllLiveBalances({
        actorUserId: ownerUser.id,
        skipInFlight: true,
      });
      const r1 = syncOut.results.find((r) => r.slotCode === "RESERVE_1");
      assert.equal(r1?.status, "SKIPPED_IN_FLIGHT");

      // P1 (Item 7): Failed live sync does NOT refresh stale lastSyncedAt
      const staleDate = new Date(Date.now() - 3 * 3600_000);
      await prisma.disbursementChunk.updateMany({
        where: { sourceAccountId: slotRes.id, status: "IN_FLIGHT" },
        data: { status: "SUCCEEDED" },
      });
      await prisma.gameAccount.update({
        where: { id: slotRes.id },
        data: { lastSyncedAt: staleDate },
      });
      const failingAdapter = {
        fetchLiveBalanceAsync: async () => ({ ok: false, status: 500, error: "Timeout" }),
      } as unknown as LagosLifeAdapter;
      const failingInvSvc = new InventoryService(prisma, {
        encryptionKeyHex: env.ENCRYPTION_KEY_HEX,
        lagosLifeAdapter: failingAdapter,
      });
      const failedSyncOut = await failingInvSvc.syncAllLiveBalances({
        actorUserId: ownerUser.id,
        skipInFlight: true,
      });
      const r1Failed = failedSyncOut.results.find((r) => r.slotCode === "RESERVE_1");
      assert.equal(r1Failed?.status, "ERROR");
      const afterFailedAcc = await prisma.gameAccount.findUnique({ where: { id: slotRes.id } });
      assert.equal(afterFailedAcc?.lastSyncedAt?.toISOString(), staleDate.toISOString());

      // P1 (Item 6): BullMQ inventorySyncQueue repeatable job deduplicates across worker restarts
      if (queues.inventorySyncQueue) {
        const repeatOpts = {
          jobId: "periodic-inventory-sync",
          repeat: { every: 15 * 60_000 },
          attempts: 1,
        };
        await queues.inventorySyncQueue.add("periodic-inventory-sync", {}, repeatOpts);
        await queues.inventorySyncQueue.add("periodic-inventory-sync", {}, repeatOpts);
        const repeatables = await queues.inventorySyncQueue.getRepeatableJobs();
        const matching = repeatables.filter((r) => r.name === "periodic-inventory-sync");
        assert.equal(matching.length, 1);
        for (const r of matching) {
          await queues.inventorySyncQueue.removeRepeatableByKey(r.key);
        }
      }

      // P0.3 (Item 8): WhatsApp receipt URL builder formats configured number and order details
      const waUrl = buildWhatsAppReceiptUrl(instrJson.whatsappNumber, {
        orderNumber: "ORD-TEST-123",
        paymentReference: "PAY-REF-999",
        amountDueNaira: "₦5,000",
        gameAmountLabel: "5T",
        recipientUsername: `target1_${runId}`,
      });
      assert.ok(waUrl && waUrl.startsWith("https://wa.me/2348012345678?text="));
      const decodedWa = decodeURIComponent(waUrl);
      assert.ok(decodedWa.includes("ORD-TEST-123"));
      assert.ok(decodedWa.includes("PAY-REF-999"));
      assert.ok(decodedWa.includes("₦5,000"));
      assert.ok(decodedWa.includes("5T"));
      assert.ok(decodedWa.includes(`@target1_${runId}`));

      // P0.4 & Item 4/9: RBAC & explicit bank credit reference enforcement
      const unauthConfirm = await app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${order250.id}/confirm-and-deliver`,
        payload: { bankCreditReference: "UNAUTH-REF" },
      });
      assert.equal(unauthConfirm.statusCode, 401);

      const custConfirm = await app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${order250.id}/confirm-and-deliver`,
        headers: { authorization: `Bearer ${custToken}` },
        payload: { bankCreditReference: "CUST-REF" },
      });
      assert.equal(custConfirm.statusCode, 403);

      const custSettings = await app.inject({
        method: "PUT",
        url: "/api/v1/owner/business-settings",
        headers: { authorization: `Bearer ${custToken}` },
        payload: {
          marketplaceSalesEnabled: true,
          retailOrdersEnabled: true,
          bulkOrdersEnabled: true,
          reason: "Unauthorized test",
        },
      });
      assert.equal(custSettings.statusCode, 403);

      const missingRefConfirm = await app.inject({
        method: "POST",
        url: `/api/v1/owner/orders/${order250.id}/confirm-and-deliver`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {},
      });
      assert.equal(missingRefConfirm.statusCode, 400);

      // Keep generateTotpCode imported check happy if unused
      assert.equal(typeof generateTotpCode, "function");
    } finally {
      if (originalBulkPricing) {
        await prisma.platformSetting.update({
          where: { key: "bulk_pricing" },
          data: { value: originalBulkPricing.value as object },
        }).catch(() => undefined);
      }
      if (originalBizSettings) {
        await prisma.platformSetting.update({
          where: { key: "business_settings" },
          data: { value: originalBizSettings.value as object },
        }).catch(() => undefined);
      }
      if (originalReserve1) {
        await prisma.gameAccount.update({
          where: { slotCode: "RESERVE_1" },
          data: {
            lastKnownBalance: originalReserve1.lastKnownBalance,
            reservedForOrders: originalReserve1.reservedForOrders,
            lastSyncedAt: originalReserve1.lastSyncedAt,
            healthStatus: originalReserve1.healthStatus,
            encryptedSessionBundle: originalReserve1.encryptedSessionBundle,
          },
        }).catch(() => undefined);
      }
      await app.close();
      await queues.close();
      await prisma.$disconnect();
    }
  });
});
