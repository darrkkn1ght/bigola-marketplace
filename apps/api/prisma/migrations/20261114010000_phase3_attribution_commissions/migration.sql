-- CreateEnum
CREATE TYPE "AttributionConflictStatus" AS ENUM ('PENDING', 'RESOLVED_KEPT_EXISTING', 'RESOLVED_REASSIGNED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ConflictMatchedField" AS ENUM ('EMAIL', 'PHONE', 'LAGOSLIFE_USERNAME');

-- CreateEnum
CREATE TYPE "CommissionLedgerEntryType" AS ENUM ('ACCRUAL', 'APPROVAL', 'PAYOUT', 'REVERSAL', 'ADJUSTMENT');

-- AlterEnum
BEGIN;
CREATE TYPE "CommissionSettlementStatus_new" AS ENUM ('PENDING_RULE', 'ACCRUED', 'APPROVED_FOR_PAYOUT', 'PAID', 'REVERSED');
ALTER TABLE "commission_records" ALTER COLUMN "settlement_status" TYPE "CommissionSettlementStatus_new" USING ("settlement_status"::text::"CommissionSettlementStatus_new");
ALTER TYPE "CommissionSettlementStatus" RENAME TO "CommissionSettlementStatus_old";
ALTER TYPE "CommissionSettlementStatus_new" RENAME TO "CommissionSettlementStatus";
DROP TYPE "public"."CommissionSettlementStatus_old";
COMMIT;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "lagoslife_username_normalized" TEXT,
ADD COLUMN     "phone_normalized" TEXT;

-- CreateTable
CREATE TABLE "attribution_conflicts" (
    "id" UUID NOT NULL,
    "existing_customer_id" UUID NOT NULL,
    "existing_partner_id" UUID,
    "requested_partner_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "matched_field" "ConflictMatchedField" NOT NULL,
    "matched_value_hash" TEXT NOT NULL,
    "matched_value_masked" TEXT NOT NULL,
    "status" "AttributionConflictStatus" NOT NULL DEFAULT 'PENDING',
    "resolution_reason" TEXT,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribution_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_ledger_entries" (
    "id" UUID NOT NULL,
    "commission_record_id" UUID NOT NULL,
    "partner_id" UUID,
    "entry_type" "CommissionLedgerEntryType" NOT NULL,
    "partner_delta_kobo" BIGINT NOT NULL,
    "owner_delta_kobo" BIGINT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attribution_conflicts_status_created_at_idx" ON "attribution_conflicts"("status", "created_at");

-- CreateIndex
CREATE INDEX "attribution_conflicts_requested_partner_id_idx" ON "attribution_conflicts"("requested_partner_id");

-- CreateIndex
CREATE INDEX "commission_ledger_entries_commission_record_id_created_at_idx" ON "commission_ledger_entries"("commission_record_id", "created_at");

-- CreateIndex
CREATE INDEX "commission_ledger_entries_partner_id_entry_type_idx" ON "commission_ledger_entries"("partner_id", "entry_type");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_normalized_key" ON "customers"("phone_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "customers_lagoslife_username_normalized_key" ON "customers"("lagoslife_username_normalized");

-- AddForeignKey
ALTER TABLE "attribution_conflicts" ADD CONSTRAINT "attribution_conflicts_existing_customer_id_fkey" FOREIGN KEY ("existing_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_conflicts" ADD CONSTRAINT "attribution_conflicts_existing_partner_id_fkey" FOREIGN KEY ("existing_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_conflicts" ADD CONSTRAINT "attribution_conflicts_requested_partner_id_fkey" FOREIGN KEY ("requested_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_conflicts" ADD CONSTRAINT "attribution_conflicts_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_conflicts" ADD CONSTRAINT "attribution_conflicts_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_ledger_entries" ADD CONSTRAINT "commission_ledger_entries_commission_record_id_fkey" FOREIGN KEY ("commission_record_id") REFERENCES "commission_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_ledger_entries" ADD CONSTRAINT "commission_ledger_entries_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_ledger_entries" ADD CONSTRAINT "commission_ledger_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

