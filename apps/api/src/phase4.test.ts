import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CustomerCategory,
  GameAccountHealth,
  OrderChannel,
  OrderStatus,
  Prisma,
  PrismaClient,
  UserRole,
} from "@prisma/client";
import { ONE_TRILLION } from "@bigola/shared";
import { buildApp } from "./app.js";
import { loadIsolatedTestEnv } from "./lib/test-isolation.js";
import { generateTotpCode, hashPassword } from "./lib/crypto.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import { createPrismaStores } from "./lib/repositories.js";
import { AttributionService } from "./services/attribution.js";
import { InventoryService } from "./services/inventory.js";
import { OrderService } from "./services/order.js";

const RUN_INFRA = process.env.RUN_INFRA_TESTS === "true";

describe("Phase 4 Orders, Pricing & Inventory Integrity (Neon PostgreSQL)", { skip: !RUN_INFRA }, () => {
  it("enforces concurrent reservations, overselling prevention, idempotency, expiry, freshness, hoarding limits, and RBAC", async () => {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Refusing Phase 4 integration tests against NODE_ENV=production.");
    }

    const env = loadIsolatedTestEnv();
    assert.equal(env.DISBURSEMENT_ENABLED, false);
    const prisma = new PrismaClient();
    const stores = createPrismaStores(prisma);
    const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);
    const attributionService = new AttributionService(prisma, env.SESSION_SECRET);
    const orderService = new OrderService(prisma);
    const inventoryService = new InventoryService(prisma);

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
      checkDb: async () => true,
    });

    const runId = Date.now().toString(36);
    const createdUserIds: string[] = [];
    const createdCustomerIds: string[] = [];
    const createdPartnerIds: string[] = [];
    const createdOrderIds: string[] = [];

    const originalBulkSetting = await prisma.platformSetting.findUnique({
      where: { key: "bulk_pricing" },
    });
    const originalAccounts = await prisma.gameAccount.findMany();

    try {
      // 1. Create Owner (2FA), 2 Partners, and 2 Customers
      const ownerUser = await prisma.user.create({
        data: {
          email: `p4-owner-${runId}@bigola.test`,
          passwordHash: await hashPassword("OwnerStrongPass123!"),
          role: UserRole.OWNER,
          mfaEnabled: false,
        },
      });
      createdUserIds.push(ownerUser.id);

      const partner1User = await prisma.user.create({
        data: {
          email: `p4-partner1-${runId}@bigola.test`,
          passwordHash: await hashPassword("PartnerPass123!"),
          role: UserRole.PARTNER,
        },
      });
      const partner2User = await prisma.user.create({
        data: {
          email: `p4-partner2-${runId}@bigola.test`,
          passwordHash: await hashPassword("PartnerPass123!"),
          role: UserRole.PARTNER,
        },
      });
      createdUserIds.push(partner1User.id, partner2User.id);

      const partner1 = await prisma.partner.create({
        data: {
          userId: partner1User.id,
          referralCode: `P4A-${runId.toUpperCase()}`,
          displayName: "Phase4 Partner A",
        },
      });
      const partner2 = await prisma.partner.create({
        data: {
          userId: partner2User.id,
          referralCode: `P4B-${runId.toUpperCase()}`,
          displayName: "Phase4 Partner B",
        },
      });
      createdPartnerIds.push(partner1.id, partner2.id);

      const cust1User = await prisma.user.create({
        data: {
          email: `p4-cust1-${runId}@bigola.test`,
          passwordHash: await hashPassword("CustPass123!"),
          role: UserRole.CUSTOMER,
        },
      });
      const cust2User = await prisma.user.create({
        data: {
          email: `p4-cust2-${runId}@bigola.test`,
          passwordHash: await hashPassword("CustPass123!"),
          role: UserRole.CUSTOMER,
        },
      });
      createdUserIds.push(cust1User.id, cust2User.id);

      const cust1 = await prisma.customer.create({
        data: {
          userId: cust1User.id,
          fullName: "Phase4 Customer 1",
          email: cust1User.email,
          category: CustomerCategory.CATEGORY_A_PARTNER,
          attributedPartnerId: partner1.id,
        },
      });
      const cust2 = await prisma.customer.create({
        data: {
          userId: cust2User.id,
          fullName: "Phase4 Customer 2",
          email: cust2User.email,
          category: CustomerCategory.CATEGORY_B_BIGOLA,
        },
      });
      createdCustomerIds.push(cust1.id, cust2.id);

      // Login helper
      const loginAs = async (email: string, password: string) => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email, password },
        });
        assert.equal(res.statusCode, 200, `Login failed for ${email}: ${res.body}`);
        const cookieMap = new Map<string, string>();
        for (const c of res.cookies) cookieMap.set(c.name, c.value);
        return {
          token: res.json().token as string,
          cookieHeader: Array.from(cookieMap.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join("; "),
          csrf: cookieMap.get("bigola_csrf") ?? "",
        };
      };

      const ownerAuth = await loginAs(ownerUser.email, "OwnerStrongPass123!");
      const setup2fa = await app.inject({
        method: "POST",
        url: "/api/v1/auth/2fa/setup",
        headers: { authorization: `Bearer ${ownerAuth.token}` },
      });
      assert.equal(setup2fa.statusCode, 200);
      const totpSecret = setup2fa.json().manualKey as string;
      const enable2fa = await app.inject({
        method: "POST",
        url: "/api/v1/auth/2fa/enable",
        headers: { authorization: `Bearer ${ownerAuth.token}` },
        payload: { code: generateTotpCode(totpSecret) },
      });
      assert.equal(enable2fa.statusCode, 200);

      const partner1Auth = await loginAs(partner1User.email, "PartnerPass123!");
      const partner2Auth = await loginAs(partner2User.email, "PartnerPass123!");
      const cust1Auth = await loginAs(cust1User.email, "CustPass123!");
      const cust2Auth = await loginAs(cust2User.email, "CustPass123!");

      // 2. Ensure deterministic baseline on seeded slots before syncing RESERVE_1 (20T) and MAIN_TREASURY (15T) -> 35T fresh; make RESERVE_2 STALE (50T)
      await prisma.gameAccount.updateMany({
        where: { slotCode: { in: ["MAIN_TREASURY", "RESERVE_1"] } },
        data: { reservedForOrders: "0" },
      });
      const syncR1 = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/sync",
        headers: { cookie: ownerAuth.cookieHeader, "x-csrf-token": ownerAuth.csrf },
        payload: {
          slotCode: "RESERVE_1",
          observedBalance: (20n * ONE_TRILLION).toString(),
          healthStatus: GameAccountHealth.ACTIVE,
          reason: "Phase 4 test fresh reserve 1",
        },
      });
      assert.equal(syncR1.statusCode, 200, `RESERVE_1 sync failed: ${syncR1.body}`);
      const syncMain = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/sync",
        headers: { cookie: ownerAuth.cookieHeader, "x-csrf-token": ownerAuth.csrf },
        payload: {
          slotCode: "MAIN_TREASURY",
          observedBalance: (15n * ONE_TRILLION).toString(),
          healthStatus: GameAccountHealth.ACTIVE,
          reason: "Phase 4 test fresh treasury",
        },
      });
      assert.equal(syncMain.statusCode, 200, `MAIN_TREASURY sync failed: ${syncMain.body}`);
      // Mark RESERVE_2 with 50T but stale lastSyncedAt (2 hours ago)
      await prisma.gameAccount.update({
        where: { slotCode: "RESERVE_2" },
        data: {
          lastKnownBalance: (50n * ONE_TRILLION).toString(),
          reservedForOrders: "0",
          healthStatus: GameAccountHealth.ACTIVE,
          lastSyncedAt: new Date(Date.now() - 120 * 60_000),
        },
      });
      // Ensure RESERVE_3 & RESERVE_4 are 0
      await prisma.gameAccount.updateMany({
        where: { slotCode: { in: ["RESERVE_3", "RESERVE_4"] } },
        data: { lastKnownBalance: "0", reservedForOrders: "0", healthStatus: GameAccountHealth.UNCONFIGURED },
      });

      // Verify Owner inventory overview flags RESERVE_2 as STALE and excludes its 50T from reservableAvailable
      const invRes = await app.inject({
        method: "GET",
        url: "/api/v1/owner/inventory",
        headers: { cookie: ownerAuth.cookieHeader },
      });
      assert.equal(invRes.statusCode, 200);
      const invBody = invRes.json();
      const r2Slot = invBody.slots.find((s: { slotCode: string }) => s.slotCode === "RESERVE_2");
      assert.equal(r2Slot.effectiveHealthStatus, "STALE");
      assert.equal(r2Slot.isStale, true);
      assert.equal(r2Slot.reservableAvailable, "0");
      assert.equal(invBody.totals.reservableAvailable, (35n * ONE_TRILLION).toString());

      // Logical allocation must NOT change observedBalance
      const allocRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/inventory/allocate-reserve",
        headers: { cookie: ownerAuth.cookieHeader, "x-csrf-token": ownerAuth.csrf },
        payload: {
          targetSlotCode: "RESERVE_1",
          logicalAllocationAmount: (70n * ONE_TRILLION).toString(),
          reason: "Logical target update only",
        },
      });
      assert.equal(allocRes.statusCode, 200);
      assert.equal(allocRes.json().logicalOnly, true);
      assert.equal(allocRes.json().account.observedBalance, (20n * ONE_TRILLION).toString());

      // 3. Retail pricing remains UNCONFIGURED
      const retailRes = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: {
          cookie: cust1Auth.cookieHeader,
          "x-csrf-token": cust1Auth.csrf,
          "idempotency-key": `retail-unconf-${runId}`,
        },
        payload: {
          orderType: "RETAIL",
          packageId: "pkg-1",
          recipientLagoslifeUsername: "buyer_one",
        },
      });
      assert.equal(retailRes.statusCode, 409);
      assert.equal(retailRes.json().code, "PRICING_UNCONFIGURED");

      // 4. Idempotency: same key + same payload replays; same key + different payload -> 409 IDEMPOTENCY_CONFLICT
      const idemKey = `idem-key-${runId}`;
      const ord1Res = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: {
          cookie: cust1Auth.cookieHeader,
          "x-csrf-token": cust1Auth.csrf,
          "idempotency-key": idemKey,
        },
        payload: {
          orderType: "BULK",
          gameAmount: (10n * ONE_TRILLION).toString(),
          recipientLagoslifeUsername: "buyer_one",
        },
      });
      assert.equal(ord1Res.statusCode, 201);
      const ord1 = ord1Res.json().order;
      createdOrderIds.push(ord1.id);
      assert.equal(ord1.fiatAmountKobo, "1000000"); // 10T * ₦1,000 = ₦10,000 = 1,000,000 kobo
      assert.equal(ord1.customerCategory, CustomerCategory.CATEGORY_A_PARTNER);
      assert.equal(ord1.partnerId, partner1.id);
      assert.ok(ord1.expiresAt);

      const replayRes = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: {
          cookie: cust1Auth.cookieHeader,
          "x-csrf-token": cust1Auth.csrf,
          "idempotency-key": idemKey,
        },
        payload: {
          orderType: "BULK",
          gameAmount: (10n * ONE_TRILLION).toString(),
          recipientLagoslifeUsername: "@Buyer_One", // normalizes identically
        },
      });
      assert.equal(replayRes.statusCode, 200);
      assert.equal(replayRes.json().idempotentReplay, true);
      assert.equal(replayRes.json().order.id, ord1.id);

      const conflictRes = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: {
          cookie: cust1Auth.cookieHeader,
          "x-csrf-token": cust1Auth.csrf,
          "idempotency-key": idemKey,
        },
        payload: {
          orderType: "BULK",
          gameAmount: (11n * ONE_TRILLION).toString(),
          recipientLagoslifeUsername: "buyer_one",
        },
      });
      assert.equal(conflictRes.statusCode, 409);
      assert.equal(conflictRes.json().code, "IDEMPOTENCY_CONFLICT");

      // 5. Pricing Snapshot Immutability: Owner changes bulk_pricing, existing order keeps old snapshot & kobo
      await app.inject({
        method: "PUT",
        url: "/api/v1/owner/pricing/bulk",
        headers: { cookie: ownerAuth.cookieHeader, "x-csrf-token": ownerAuth.csrf },
        payload: {
          priceKoboPerTrillion: "120000",
          minBulkGameAmount: (10n * ONE_TRILLION).toString(),
          enabled: true,
          reason: "Test rate update",
        },
      });
      const ord1Check = await prisma.order.findUniqueOrThrow({ where: { id: ord1.id } });
      assert.equal(ord1Check.fiatAmountKobo.toString(), "1000000");

      // 6. Concurrent Reservations & Overselling Prevention (25T fresh left across RESERVE_1 + MAIN_TREASURY; fire 4 parallel 10T orders)
      const parallelResults = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/v1/orders",
          headers: { cookie: cust2Auth.cookieHeader, "x-csrf-token": cust2Auth.csrf, "idempotency-key": `p-1-${runId}` },
          payload: { orderType: "BULK", gameAmount: (10n * ONE_TRILLION).toString(), recipientLagoslifeUsername: "c2_a" },
        }),
        app.inject({
          method: "POST",
          url: "/api/v1/orders",
          headers: { cookie: cust2Auth.cookieHeader, "x-csrf-token": cust2Auth.csrf, "idempotency-key": `p-2-${runId}` },
          payload: { orderType: "BULK", gameAmount: (10n * ONE_TRILLION).toString(), recipientLagoslifeUsername: "c2_b" },
        }),
        app.inject({
          method: "POST",
          url: "/api/v1/orders",
          headers: { cookie: cust1Auth.cookieHeader, "x-csrf-token": cust1Auth.csrf, "idempotency-key": `p-3-${runId}` },
          payload: { orderType: "BULK", gameAmount: (10n * ONE_TRILLION).toString(), recipientLagoslifeUsername: "c1_b" },
        }),
        app.inject({
          method: "POST",
          url: "/api/v1/orders",
          headers: { cookie: cust2Auth.cookieHeader, "x-csrf-token": cust2Auth.csrf, "idempotency-key": `p-4-${runId}` },
          payload: { orderType: "BULK", gameAmount: (10n * ONE_TRILLION).toString(), recipientLagoslifeUsername: "c2_c" },
        }),
      ]);

      const succeeded = parallelResults.filter((r) => r.statusCode === 201);
      const rejected = parallelResults.filter((r) => r.statusCode === 409);
      for (const r of succeeded) createdOrderIds.push(r.json().order.id);
      // Only 25T remained, so at most 2 orders of 10T (20T) can succeed!
      assert.equal(succeeded.length, 2, `Expected exactly 2 parallel orders to succeed, got ${succeeded.length}`);
      assert.equal(rejected.length, 2);
      for (const r of rejected) assert.equal(r.json().code, "INSUFFICIENT_INVENTORY");

      // Verify DB invariant: reservedForOrders <= lastKnownBalance on all accounts
      const afterAccounts = await prisma.gameAccount.findMany();
      for (const a of afterAccounts) {
        assert.ok(a.reservedForOrders.lte(a.lastKnownBalance), `Oversold on ${a.slotCode}`);
      }

      // 7. Authorization: Customer 2 cannot view or cancel Customer 1's order; Partner 2 cannot order for Partner 1's customer
      const crossView = await app.inject({
        method: "GET",
        url: `/api/v1/customer/orders/${ord1.id}`,
        headers: { cookie: cust2Auth.cookieHeader },
      });
      assert.equal(crossView.statusCode, 404);

      const crossPartnerOrder = await app.inject({
        method: "POST",
        url: "/api/v1/partner/orders",
        headers: { cookie: partner2Auth.cookieHeader, "x-csrf-token": partner2Auth.csrf },
        payload: {
          customerId: cust1.id,
          orderType: "BULK",
          gameAmount: (10n * ONE_TRILLION).toString(),
          recipientLagoslifeUsername: "buyer_one",
        },
      });
      assert.equal(crossPartnerOrder.statusCode, 403);

      // Cancel one of cust2's orders, then verify Partner 1 CAN create an OFFLINE_PARTNER order for cust1
      const cancelCust2Res = await app.inject({
        method: "POST",
        url: `/api/v1/customer/orders/${succeeded[0].json().order.id}/cancel`,
        headers: { cookie: cust2Auth.cookieHeader, "x-csrf-token": cust2Auth.csrf },
        payload: { reason: "Testing release" },
      });
      assert.equal(cancelCust2Res.statusCode, 200);
      assert.equal(cancelCust2Res.json().order.status, OrderStatus.CANCELLED);

      const partnerOfflineOrder = await app.inject({
        method: "POST",
        url: "/api/v1/partner/orders",
        headers: {
          cookie: partner1Auth.cookieHeader,
          "x-csrf-token": partner1Auth.csrf,
          "idempotency-key": `poff-${runId}`,
        },
        payload: {
          customerId: cust1.id,
          orderType: "BULK",
          gameAmount: (10n * ONE_TRILLION).toString(),
          recipientLagoslifeUsername: "buyer_one",
        },
      });
      assert.equal(partnerOfflineOrder.statusCode, 201);
      const poffOrder = partnerOfflineOrder.json().order;
      createdOrderIds.push(poffOrder.id);
      assert.equal(poffOrder.channel, OrderChannel.OFFLINE_PARTNER);
      assert.equal(poffOrder.partnerId, partner1.id);

      // 8. Expiry release during subsequent order creation & Owner manual sweep
      await prisma.order.update({
        where: { id: ord1.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const sweepRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/orders/expire-stale",
        headers: { cookie: ownerAuth.cookieHeader, "x-csrf-token": ownerAuth.csrf },
        payload: {},
      });
      assert.equal(sweepRes.statusCode, 200);
      assert.ok(sweepRes.json().expiredCount >= 1);

      const expiredOrd1 = await prisma.order.findUniqueOrThrow({ where: { id: ord1.id } });
      assert.equal(expiredOrd1.status, OrderStatus.EXPIRED);

      // 9. Hoarding limit enforcement (maxActiveUnpaidOrdersPerCustomer = 3)
      // Give RESERVE_1 enough balance for hoarding test
      await prisma.gameAccount.update({
        where: { slotCode: "RESERVE_1" },
        data: { lastKnownBalance: (200n * ONE_TRILLION).toString() },
      });
      const hoard1 = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: { cookie: cust1Auth.cookieHeader, "x-csrf-token": cust1Auth.csrf, "idempotency-key": `h1-${runId}` },
        payload: { orderType: "BULK", gameAmount: (10n * ONE_TRILLION).toString(), recipientLagoslifeUsername: "h1" },
      });
      if (hoard1.statusCode === 201) createdOrderIds.push(hoard1.json().order.id);
      const hoard2 = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: { cookie: cust1Auth.cookieHeader, "x-csrf-token": cust1Auth.csrf, "idempotency-key": `h2-${runId}` },
        payload: { orderType: "BULK", gameAmount: (10n * ONE_TRILLION).toString(), recipientLagoslifeUsername: "h2" },
      });
      if (hoard2.statusCode === 201) createdOrderIds.push(hoard2.json().order.id);
      const hoard3 = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: { cookie: cust1Auth.cookieHeader, "x-csrf-token": cust1Auth.csrf, "idempotency-key": `h3-${runId}` },
        payload: { orderType: "BULK", gameAmount: (10n * ONE_TRILLION).toString(), recipientLagoslifeUsername: "h3" },
      });
      if (hoard3.statusCode === 201) createdOrderIds.push(hoard3.json().order.id);
      // 4th active unpaid order for cust1 must fail with 429 HOARDING_LIMIT_EXCEEDED
      const hoardOver = await app.inject({
        method: "POST",
        url: "/api/v1/orders",
        headers: { cookie: cust1Auth.cookieHeader, "x-csrf-token": cust1Auth.csrf, "idempotency-key": `hover-${runId}` },
        payload: { orderType: "BULK", gameAmount: (10n * ONE_TRILLION).toString(), recipientLagoslifeUsername: "hover" },
      });
      assert.equal(hoardOver.statusCode, 429);
      assert.equal(hoardOver.json().code, "HOARDING_LIMIT_EXCEEDED");

      // 10. No commissions calculated in Phase 4
      const commCount = await prisma.commissionRecord.count({
        where: { orderId: { in: createdOrderIds } },
      });
      assert.equal(commCount, 0);
    } finally {
      if (originalBulkSetting) {
        await prisma.platformSetting.update({
          where: { key: "bulk_pricing" },
          data: { value: originalBulkSetting.value as Prisma.InputJsonValue },
        });
      }
      if (createdOrderIds.length > 0) {
        await prisma.inventoryLedger.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.inventoryReservation.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      }
      if (createdCustomerIds.length > 0) {
        await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
      }
      if (createdPartnerIds.length > 0) {
        await prisma.partner.deleteMany({ where: { id: { in: createdPartnerIds } } });
      }
      if (createdUserIds.length > 0) {
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

