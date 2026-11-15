import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UserRole,
  Permission,
  hasPermission,
  calculateCommissionSplit,
  calculateBulkOrderFiatKobo,
  normalizeEmail,
  normalizePhone,
  normalizeLagoslifeUsername,
  normalizeReferralCode,
  maskIdentifier,
  PRIMARY_SUPPLIER_USERNAME,
  INITIAL_ACTIVE_RESERVE_TARGET,
} from "./index.js";

describe("RBAC Permission Matrix", () => {
  it("isolates Customer, Partner, OpsAdmin, and Owner permissions", () => {
    assert.equal(hasPermission(UserRole.CUSTOMER, Permission.ORDER_CREATE_OWN), true);
    assert.equal(hasPermission(UserRole.CUSTOMER, Permission.SUPPORT_TICKET_OWN), true);
    assert.equal(hasPermission(UserRole.CUSTOMER, Permission.SUPPORT_TICKET_MANAGE), false);
    assert.equal(hasPermission(UserRole.CUSTOMER, Permission.PARTNER_DASHBOARD_OWN), false);
    assert.equal(hasPermission(UserRole.CUSTOMER, Permission.OWNER_DASHBOARD_VIEW), false);

    assert.equal(hasPermission(UserRole.PARTNER, Permission.PARTNER_DASHBOARD_OWN), true);
    assert.equal(hasPermission(UserRole.PARTNER, Permission.PARTNER_OFFLINE_CUSTOMER_REGISTER), true);
    assert.equal(hasPermission(UserRole.PARTNER, Permission.SUPPORT_TICKET_PARTNER), true);
    assert.equal(hasPermission(UserRole.PARTNER, Permission.ORDER_FULFILMENT_CONFIRM), false);
    assert.equal(hasPermission(UserRole.PARTNER, Permission.PAYMENT_PROOF_VERIFY), false);
    assert.equal(hasPermission(UserRole.PARTNER, Permission.OWNER_COMMISSION_RULE_CONFIGURE), false);

    assert.equal(hasPermission(UserRole.OPS_ADMIN, Permission.PAYMENT_PROOF_VERIFY), false);
    assert.equal(hasPermission(UserRole.OPS_ADMIN, Permission.PAYMENT_QUEUE_VIEW), false);
    assert.equal(hasPermission(UserRole.OPS_ADMIN, Permission.ORDER_VIEW_ALL), true);
    assert.equal(hasPermission(UserRole.OPS_ADMIN, Permission.SUPPORT_TICKET_MANAGE), true);
    assert.equal(hasPermission(UserRole.OPS_ADMIN, Permission.ORDER_FULFILMENT_CONFIRM), false);
    assert.equal(hasPermission(UserRole.OPS_ADMIN, Permission.ORDER_REFUND_MANAGE), false);
    assert.equal(hasPermission(UserRole.OPS_ADMIN, Permission.OWNER_INVENTORY_MANAGE), false);
    assert.equal(hasPermission(UserRole.OPS_ADMIN, Permission.OWNER_DISBURSEMENT_CONTROL), true);
    assert.equal(hasPermission(UserRole.OPS_ADMIN, Permission.OWNER_SETTINGS_MANAGE), false);

    assert.equal(hasPermission(UserRole.OWNER, Permission.OWNER_COMMISSION_RULE_CONFIGURE), true);
    assert.equal(hasPermission(UserRole.OWNER, Permission.OWNER_AUDIT_LOG_READ), true);
    assert.equal(hasPermission(UserRole.OWNER, Permission.ORDER_FULFILMENT_CONFIRM), true);
    assert.equal(hasPermission(UserRole.OWNER, Permission.ORDER_REFUND_MANAGE), true);
    assert.equal(hasPermission(UserRole.OWNER, Permission.OWNER_INVENTORY_MANAGE), true);
  });
});

describe("Commercial & Commission Rules", () => {
  it("confirms primary supplier and 280T initial reserve target", () => {
    assert.equal(PRIMARY_SUPPLIER_USERNAME, "bigola2823");
    assert.equal(INITIAL_ACTIVE_RESERVE_TARGET, 280_000_000_000_000n);
  });

  it("calculates strict 50/50 gross split for Category A without losing kobo", () => {
    const evenSplit = calculateCommissionSplit(2_000_000n, {
      category: "CATEGORY_A_PARTNER",
      partnerShareBps: 5000,
      ownerShareBps: 5000,
    });
    assert.equal(evenSplit.status, "ACCRUED");
    assert.equal(evenSplit.partnerEntitlementKobo, 1_000_000n);
    assert.equal(evenSplit.ownerEntitlementKobo, 1_000_000n);

    const oddSplit = calculateCommissionSplit(101n, {
      category: "CATEGORY_A_PARTNER",
      partnerShareBps: 5000,
      ownerShareBps: 5000,
    });
    assert.equal(oddSplit.status, "ACCRUED");
    assert.equal(oddSplit.partnerEntitlementKobo! + oddSplit.ownerEntitlementKobo!, 101n);
  });

  it("keeps Category B uncalculated (PENDING_RULE) until explicitly configured", () => {
    const pending = calculateCommissionSplit(500_000n, {
      category: "CATEGORY_B_BIGOLA",
      status: "PENDING_RULE",
    });
    assert.equal(pending.status, "PENDING_RULE");
    assert.equal(pending.partnerEntitlementKobo, null);
    assert.equal(pending.ownerEntitlementKobo, null);
  });

  it("calculates bulk pricing at ₦1,000 per 1T with 10T minimum", () => {
    assert.equal(calculateBulkOrderFiatKobo(10_000_000_000_000n), 1_000_000n);
    assert.throws(() => calculateBulkOrderFiatKobo(9_000_000_000_000n), /at least/);
  });

  it("normalizes and masks emails, phones, LagosLife usernames, and referral codes", () => {
    assert.equal(normalizeEmail("  Buyer@Example.COM "), "buyer@example.com");
    assert.equal(normalizePhone("0803 123 4567"), "+2348031234567");
    assert.equal(normalizePhone("+234-803-123-4567"), "+2348031234567");
    assert.equal(normalizeLagoslifeUsername(" @BigBuyer "), "bigbuyer");
    assert.equal(normalizeReferralCode(" bgo-123 "), "BGO-123");
    assert.equal(maskIdentifier("buyer@example.com", "EMAIL"), "b***@example.com");
    assert.equal(maskIdentifier("+2348031234567", "PHONE"), "***4567");
  });
});

