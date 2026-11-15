import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CustomerCategory, PrismaClient, UserRole } from "@prisma/client";
import { loadIsolatedTestEnv } from "./lib/test-isolation.js";
import { buildApp } from "./app.js";
import { createQueueInfrastructure } from "./lib/redis.js";
import { createPrismaStores } from "./lib/repositories.js";
import { AttributionService } from "./services/attribution.js";
import { OrderService } from "./services/order.js";
import { InventoryService } from "./services/inventory.js";
import { CommissionService } from "./services/commission.js";
import { NotificationService } from "./services/notification.js";
import { VerificationService } from "./services/verification.js";
import { generateTotpCode, hashPassword } from "./lib/crypto.js";

const runInfraTests = process.env.RUN_INFRA_TESTS === "true";

describe("Phase 6 Authentication, Provisioning & Gap Endpoints (Neon PostgreSQL)", { skip: !runInfraTests }, () => {
  it("supports Partner invite setup, Owner-controlled password reset, customer profile, and RBAC isolation", async () => {
    const env = loadIsolatedTestEnv();
    const prisma = new PrismaClient();
    const stores = createPrismaStores(prisma);
    const queues = createQueueInfrastructure(env.REDIS_URL, env.QUEUE_PREFIX);
    const commissionService = new CommissionService(prisma);
    const notificationService = new NotificationService(prisma);
    const verificationService = new VerificationService(prisma, commissionService, notificationService);

    const app = await buildApp({
      env,
      authStore: stores.authStore,
      auditStore: stores.auditStore,
      platformStore: stores.platformStore,
      queues,
      checkDb: async () => true,
      prisma,
      attributionService: new AttributionService(prisma, env.SESSION_SECRET),
      orderService: new OrderService(prisma),
      inventoryService: new InventoryService(prisma),
      verificationService,
      notificationService,
    });

    const runId = Date.now().toString(36);
    const createdUserIds: string[] = [];
    const createdPartnerIds: string[] = [];
    const createdCustomerIds: string[] = [];

    try {
      const ownerUser = await prisma.user.create({
        data: {
          email: `p6-owner-${runId}@bigola.test`,
          passwordHash: await hashPassword("OwnerStrongPass123!"),
          role: UserRole.OWNER,
          mfaEnabled: false,
        },
      });
      const custUser = await prisma.user.create({
        data: {
          email: `p6-cust-${runId}@bigola.test`,
          passwordHash: await hashPassword("CustStrongPass123!"),
          role: UserRole.CUSTOMER,
        },
      });
      createdUserIds.push(ownerUser.id, custUser.id);

      const cust = await prisma.customer.create({
        data: {
          userId: custUser.id,
          fullName: "Phase 6 Buyer",
          email: custUser.email,
          category: CustomerCategory.CATEGORY_B_BIGOLA,
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

      const custToken = await loginAs(custUser.email, "CustStrongPass123!");

      // 1. Partner invitation without password -> returns one-time inviteToken
      const inviteRes = await app.inject({
        method: "POST",
        url: "/api/v1/owner/partners",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          email: `p6-partner-${runId}@bigola.test`,
          displayName: "Phase 6 Invited Partner",
        },
      });
      assert.equal(inviteRes.statusCode, 201);
      const invitedUserId = inviteRes.json().user.id as string;
      const invitedPartnerId = inviteRes.json().partner.id as string;
      const inviteToken = inviteRes.json().inviteToken as string;
      assert.ok(inviteToken && inviteToken.length >= 20);
      createdUserIds.push(invitedUserId);
      createdPartnerIds.push(invitedPartnerId);

      // Partner completes password setup via /auth/reset-password
      const completeInvite = await app.inject({
        method: "POST",
        url: "/api/v1/auth/reset-password",
        payload: { token: inviteToken, newPassword: "PartnerChosenPass123!" },
      });
      assert.equal(completeInvite.statusCode, 200);

      // Reusing invite token must fail (400)
      const reuseInvite = await app.inject({
        method: "POST",
        url: "/api/v1/auth/reset-password",
        payload: { token: inviteToken, newPassword: "AnotherPassword123!" },
      });
      assert.equal(reuseInvite.statusCode, 400);

      // Partner signs in and /auth/me includes partnerCanVerifyPayments: false
      const partnerToken = await loginAs(`p6-partner-${runId}@bigola.test`, "PartnerChosenPass123!");
      const meRes = await app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${partnerToken}` },
      });
      assert.equal(meRes.statusCode, 200);
      assert.equal(meRes.json().user.partnerCanVerifyPayments, false);

      // 2. Customer profile GET & PATCH
      const profPatch = await app.inject({
        method: "PATCH",
        url: "/api/v1/customer/profile",
        headers: { authorization: `Bearer ${custToken}` },
        payload: { fullName: "Phase 6 Updated Buyer", lagoslifeUsername: "p6_buyer_handle" },
      });
      assert.equal(profPatch.statusCode, 200);
      assert.equal(profPatch.json().profile.lagoslifeUsername, "p6_buyer_handle");

      // 3. Partner cannot view unattributed customer orders (403)
      const unattributedOrders = await app.inject({
        method: "GET",
        url: `/api/v1/partner/customers/${cust.id}/orders`,
        headers: { authorization: `Bearer ${partnerToken}` },
      });
      assert.equal(unattributedOrders.statusCode, 403);

      // 4. Owner customer directory & audit log viewer
      const ownerCustomers = await app.inject({
        method: "GET",
        url: `/api/v1/owner/customers?q=${encodeURIComponent("Phase 6 Updated")}`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(ownerCustomers.statusCode, 200);
      assert.equal(ownerCustomers.json().customers.length, 1);

      const ownerAudit = await app.inject({
        method: "GET",
        url: "/api/v1/owner/audit-logs",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(ownerAudit.statusCode, 200);
      assert.ok(ownerAudit.json().logs.length > 0);

      // 5. Unauthorized access checks
      const partnerOnOwnerCustomers = await app.inject({
        method: "GET",
        url: "/api/v1/owner/customers",
        headers: { authorization: `Bearer ${partnerToken}` },
      });
      assert.equal(partnerOnOwnerCustomers.statusCode, 403);

      const custOnOwnerAudit = await app.inject({
        method: "GET",
        url: "/api/v1/owner/audit-logs",
        headers: { authorization: `Bearer ${custToken}` },
      });
      assert.equal(custOnOwnerAudit.statusCode, 403);

      // 6. Owner-controlled password recovery invalidates prior session
      const forgotRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/forgot-password",
        payload: { email: custUser.email },
      });
      assert.equal(forgotRes.statusCode, 200);

      const issueResetRes = await app.inject({
        method: "POST",
        url: `/api/v1/owner/users/${custUser.id}/issue-reset-token`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { reason: "Customer requested reset" },
      });
      assert.equal(issueResetRes.statusCode, 201);
      const resetToken = issueResetRes.json().resetToken as string;

      const resetRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/reset-password",
        payload: { token: resetToken, newPassword: "CustNewPassword123!" },
      });
      assert.equal(resetRes.statusCode, 200);

      // Prior customer session token must now be rejected (401)
      const oldSessionCheck = await app.inject({
        method: "GET",
        url: "/api/v1/customer/profile",
        headers: { authorization: `Bearer ${custToken}` },
      });
      assert.equal(oldSessionCheck.statusCode, 401);

      // New password works
      await loginAs(custUser.email, "CustNewPassword123!");
    } finally {
      try {
        if (createdCustomerIds.length > 0) {
          await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
        }
        if (createdPartnerIds.length > 0) {
          await prisma.partner.deleteMany({ where: { id: { in: createdPartnerIds } } });
        }
        if (createdUserIds.length > 0) {
          await prisma.notification.deleteMany({ where: { recipientUserId: { in: createdUserIds } } });
          await prisma.accountActionToken.deleteMany({
            where: {
              OR: [{ userId: { in: createdUserIds } }, { issuedById: { in: createdUserIds } }],
            },
          });
          await prisma.auditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
          await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } });
          await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
        }
      } catch (cleanupErr) {
        console.error("[phase6.test] Database cleanup failed:", cleanupErr);
      } finally {
        const teardownResults = await Promise.allSettled([
          app.close(),
          queues.close(),
          prisma.$disconnect(),
        ]);
        for (const result of teardownResults) {
          if (result.status === "rejected") {
            console.error("[phase6.test] Resource teardown failed:", result.reason);
          }
        }
      }
    }
  });
});
