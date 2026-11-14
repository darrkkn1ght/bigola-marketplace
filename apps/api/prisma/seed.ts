import { PrismaClient, GameAccountRole, GameAccountHealth, CustomerCategory, CommissionRuleStatus } from "@prisma/client";
import {
  PRIMARY_SUPPLIER_USERNAME,
  TARGET_RESERVE_PER_ACCOUNT,
  DEFAULT_BULK_PRICE_KOBO_PER_TRILLION,
  DEFAULT_BULK_MIN_GAME_AMOUNT,
} from "@bigola/shared";

const prisma = new PrismaClient();

async function main() {
  // 1. Seed initial account topology: 1 Main Treasury (`bigola2823`) + 4 Reserve Account slots (70T target each)
  await prisma.gameAccount.upsert({
    where: { slotCode: "MAIN_TREASURY" },
    update: {},
    create: {
      slotCode: "MAIN_TREASURY",
      lagoslifeUsername: PRIMARY_SUPPLIER_USERNAME,
      accountRole: GameAccountRole.MAIN_TREASURY,
      targetReserveAmount: "0",
      healthStatus: GameAccountHealth.UNCONFIGURED,
    },
  });

  for (let i = 1; i <= 4; i++) {
    await prisma.gameAccount.upsert({
      where: { slotCode: `RESERVE_${i}` },
      update: {},
      create: {
        slotCode: `RESERVE_${i}`,
        lagoslifeUsername: null, // Configured securely later by Owner
        accountRole: GameAccountRole.RESERVE,
        targetReserveAmount: TARGET_RESERVE_PER_ACCOUNT.toString(),
        healthStatus: GameAccountHealth.UNCONFIGURED,
      },
    });
  }

  // 2. Seed Commission Rules:
  //    - Category A: 50/50 split of gross verified payment
  //    - Category B: PENDING_RULE (never hardcoded)
  const existingCatA = await prisma.commissionRule.findFirst({
    where: { category: CustomerCategory.CATEGORY_A_PARTNER, status: CommissionRuleStatus.ACTIVE },
  });
  if (!existingCatA) {
    await prisma.commissionRule.create({
      data: {
        category: CustomerCategory.CATEGORY_A_PARTNER,
        status: CommissionRuleStatus.ACTIVE,
        partnerShareBps: 5000,
        ownerShareBps: 5000,
        notes: "Agreed 50/50 split of gross verified customer payment for permanently attributed Category A customers.",
      },
    });
  }

  const existingCatB = await prisma.commissionRule.findFirst({
    where: { category: CustomerCategory.CATEGORY_B_BIGOLA },
  });
  if (!existingCatB) {
    await prisma.commissionRule.create({
      data: {
        category: CustomerCategory.CATEGORY_B_BIGOLA,
        status: CommissionRuleStatus.PENDING_RULE,
        partnerShareBps: null,
        ownerShareBps: null,
        notes: "Unconfigured until commercial terms for Big Ola's own customers are finalized.",
      },
    });
  }

  // 3. Seed configurable platform settings (preserving unresolved business decisions)
  const defaultSettings: Array<{ key: string; value: object; description: string }> = [
    {
      key: "bulk_pricing",
      value: {
        priceKoboPerTrillion: DEFAULT_BULK_PRICE_KOBO_PER_TRILLION.toString(),
        minBulkGameAmount: DEFAULT_BULK_MIN_GAME_AMOUNT.toString(),
        configurableByOwner: true,
      },
      description: "Owner-configurable bulk pricing (initial: ₦1,000 per 1T, minimum 10T).",
    },
    {
      key: "regular_pricing",
      value: { status: "UNCONFIGURED", packages: [] },
      description: "Regular customer retail pricing — pending Owner configuration.",
    },
    {
      key: "bank_account_details",
      value: { status: "UNCONFIGURED", bankName: null, accountNumber: null, accountName: null },
      description: "Designated bank account for direct transfers — pending Owner configuration.",
    },
    {
      key: "order_expiry_policy",
      value: { status: "UNCONFIGURED", unpaidExpiryMinutes: null },
      description: "Unpaid order expiry window — pending Owner configuration.",
    },
    {
      key: "partner_payout_policy",
      value: { status: "UNCONFIGURED", minimumPayoutKobo: null, frequency: null },
      description: "Partner payout frequency and minimum threshold — pending commercial configuration.",
    },
  ];

  for (const setting of defaultSettings) {
    await prisma.platformSetting.upsert({
      where: { key: setting.key },
      update: {},
      create: setting,
    });
  }

  console.log("Seeded Big Ola Marketplace foundational topology, rules, and configurable settings.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

