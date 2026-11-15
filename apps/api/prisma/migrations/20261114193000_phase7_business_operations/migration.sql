-- CreateEnum
CREATE TYPE "RefundScope" AS ENUM ('PARTIAL', 'FULL');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RefundFinancialStatus" AS ENUM ('NONE', 'PARTIALLY_REFUNDED', 'FULLY_REFUNDED');

-- CreateEnum
CREATE TYPE "InventoryDiscrepancyStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SupportTicketCategory" AS ENUM ('PAYMENT_COMPLAINT', 'ORDER_DISPUTE', 'ACCOUNT_ISSUE', 'GENERAL');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportTicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- AlterEnum
ALTER TYPE "CommissionLedgerEntryType" ADD VALUE 'PARTIAL_REFUND_ADJUSTMENT';

-- AlterEnum
ALTER TYPE "InventoryEntryType" ADD VALUE 'MANUAL_FULFILMENT_DEBIT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ORDER_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_FULFILLED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_EXPIRED';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_CONFIRMED';
ALTER TYPE "NotificationType" ADD VALUE 'INVENTORY_LOW_STOCK';
ALTER TYPE "NotificationType" ADD VALUE 'INVENTORY_STALE';
ALTER TYPE "NotificationType" ADD VALUE 'INVENTORY_DISCREPANCY';
ALTER TYPE "NotificationType" ADD VALUE 'SUPPORT_TICKET_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'SUPPORT_TICKET_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'DISPUTE_OPENED';

-- DropIndex
DROP INDEX "commission_ledger_entries_commission_record_id_funding_cycle_en";

-- AlterTable
ALTER TABLE "commission_ledger_entries" ADD COLUMN     "idempotency_key" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "confirmed_refunded_kobo" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "fulfilled_amount" DECIMAL(30,0) NOT NULL DEFAULT 0,
ADD COLUMN     "refund_financial_status" "RefundFinancialStatus" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "can_confirm_fulfilment" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "manual_fulfilment_records" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "source_game_account_id" UUID NOT NULL,
    "delivered_amount" DECIMAL(30,0) NOT NULL,
    "external_reference" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "notes" TEXT,
    "confirmed_by_user_id" UUID NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_fulfilment_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_discrepancies" (
    "id" UUID NOT NULL,
    "game_account_id" UUID NOT NULL,
    "expected_balance" DECIMAL(30,0) NOT NULL,
    "observed_balance" DECIMAL(30,0) NOT NULL,
    "delta_amount" DECIMAL(30,0) NOT NULL,
    "status" "InventoryDiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "sync_ledger_id" UUID NOT NULL,
    "acknowledged_by_user_id" UUID,
    "resolution_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "inventory_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_requests" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "scope" "RefundScope" NOT NULL,
    "requested_amount_kobo" BIGINT NOT NULL,
    "current_status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "confirm_idempotency_key" TEXT,
    "confirm_request_hash" TEXT,
    "confirmed_refund_reference" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_events" (
    "id" UUID NOT NULL,
    "refund_request_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "event_type" "RefundStatus" NOT NULL,
    "amount_kobo" BIGINT NOT NULL,
    "refund_reference" TEXT,
    "reason" TEXT NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "ticket_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "partner_id" UUID,
    "order_id" UUID,
    "category" "SupportTicketCategory" NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "SupportTicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "subject" TEXT NOT NULL,
    "assigned_to_user_id" UUID,
    "resolution_summary" TEXT,
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_messages" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "manual_fulfilment_records_external_reference_key" ON "manual_fulfilment_records"("external_reference");

-- CreateIndex
CREATE UNIQUE INDEX "manual_fulfilment_records_idempotency_key_key" ON "manual_fulfilment_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "manual_fulfilment_records_order_id_confirmed_at_idx" ON "manual_fulfilment_records"("order_id", "confirmed_at");

-- CreateIndex
CREATE INDEX "manual_fulfilment_records_source_game_account_id_confirmed__idx" ON "manual_fulfilment_records"("source_game_account_id", "confirmed_at");

-- CreateIndex
CREATE INDEX "inventory_discrepancies_game_account_id_status_idx" ON "inventory_discrepancies"("game_account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "refund_requests_confirm_idempotency_key_key" ON "refund_requests"("confirm_idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "refund_requests_confirmed_refund_reference_key" ON "refund_requests"("confirmed_refund_reference");

-- CreateIndex
CREATE INDEX "refund_requests_order_id_current_status_idx" ON "refund_requests"("order_id", "current_status");

-- CreateIndex
CREATE INDEX "refund_events_refund_request_id_created_at_idx" ON "refund_events"("refund_request_id", "created_at");

-- CreateIndex
CREATE INDEX "refund_events_order_id_created_at_idx" ON "refund_events"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_ticket_number_key" ON "support_tickets"("ticket_number");

-- CreateIndex
CREATE INDEX "support_tickets_customer_id_status_idx" ON "support_tickets"("customer_id", "status");

-- CreateIndex
CREATE INDEX "support_tickets_partner_id_status_idx" ON "support_tickets"("partner_id", "status");

-- CreateIndex
CREATE INDEX "support_tickets_order_id_idx" ON "support_tickets"("order_id");

-- CreateIndex
CREATE INDEX "support_tickets_status_priority_idx" ON "support_tickets"("status", "priority");

-- CreateIndex
CREATE INDEX "support_ticket_messages_ticket_id_created_at_idx" ON "support_ticket_messages"("ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "commission_ledger_entries_idempotency_key_key" ON "commission_ledger_entries"("idempotency_key");

-- Preserve single ACCRUAL and single REVERSAL per funding cycle while allowing multiple PARTIAL_REFUND_ADJUSTMENT entries
CREATE UNIQUE INDEX "commission_ledger_entries_cycle_accrual_reversal_key" ON "commission_ledger_entries"("commission_record_id", "funding_cycle", "entry_type") WHERE "entry_type" IN ('ACCRUAL', 'REVERSAL');

-- RenameForeignKey
ALTER TABLE "receiving_bank_account_change_requests" RENAME CONSTRAINT "receiving_bank_account_change_requests_confirmed_by_user_id_fke" TO "receiving_bank_account_change_requests_confirmed_by_user_i_fkey";

-- RenameForeignKey
ALTER TABLE "receiving_bank_account_change_requests" RENAME CONSTRAINT "receiving_bank_account_change_requests_receiving_bank_account_i" TO "receiving_bank_account_change_requests_receiving_bank_acco_fkey";

-- RenameForeignKey
ALTER TABLE "receiving_bank_account_change_requests" RENAME CONSTRAINT "receiving_bank_account_change_requests_requested_by_user_id_fke" TO "receiving_bank_account_change_requests_requested_by_user_i_fkey";

-- AddForeignKey
ALTER TABLE "manual_fulfilment_records" ADD CONSTRAINT "manual_fulfilment_records_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_fulfilment_records" ADD CONSTRAINT "manual_fulfilment_records_source_game_account_id_fkey" FOREIGN KEY ("source_game_account_id") REFERENCES "game_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_fulfilment_records" ADD CONSTRAINT "manual_fulfilment_records_confirmed_by_user_id_fkey" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_discrepancies" ADD CONSTRAINT "inventory_discrepancies_game_account_id_fkey" FOREIGN KEY ("game_account_id") REFERENCES "game_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_discrepancies" ADD CONSTRAINT "inventory_discrepancies_acknowledged_by_user_id_fkey" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_refund_request_id_fkey" FOREIGN KEY ("refund_request_id") REFERENCES "refund_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "bank_statement_lines_receiving_bank_account_id_transaction_refe" RENAME TO "bank_statement_lines_receiving_bank_account_id_transaction__key";

-- RenameIndex
ALTER INDEX "bank_statement_lines_reconciliation_status_receiving_bank_accou" RENAME TO "bank_statement_lines_reconciliation_status_receiving_bank_a_idx";

-- RenameIndex
ALTER INDEX "payment_decision_statement_lines_decision_id_statement_line_id_" RENAME TO "payment_decision_statement_lines_decision_id_statement_line_key";

-- RenameIndex
ALTER INDEX "receiving_bank_account_change_requests_owner_partner_id_status_" RENAME TO "receiving_bank_account_change_requests_owner_partner_id_sta_idx";

