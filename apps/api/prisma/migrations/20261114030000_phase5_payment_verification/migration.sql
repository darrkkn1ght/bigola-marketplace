-- Phase 5: Independent Payment Verification, OPay Statement Reconciliation, Split Payments & Funding-Cycle Commissions

CREATE TYPE "PaymentExceptionType" AS ENUM ('NONE', 'PARTIAL_PAYMENT', 'EXCESS_PAYMENT', 'SPLIT_TRANSFER', 'DUPLICATE_PAYMENT');
CREATE TYPE "VerificationDecisionType" AS ENUM ('APPROVED', 'REJECTED', 'EXCEPTION_FLAGGED', 'REVERSED');
CREATE TYPE "BankAccountChangeRequestStatus" AS ENUM ('PENDING_PARTNER_CONFIRMATION', 'APPROVED', 'REJECTED');
CREATE TYPE "BankStatementFormat" AS ENUM ('CSV', 'JSON');
CREATE TYPE "BankStatementLineStatus" AS ENUM ('UNMATCHED', 'LINKED');
CREATE TYPE "NotificationType" AS ENUM ('PAYMENT_AWAITING_REVIEW', 'PAYMENT_EXCEPTION_REVIEW', 'PAYMENT_APPROVED', 'PAYMENT_REJECTED', 'PAYMENT_REVERSED');

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_SUBMITTED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_EXCEPTION_REVIEW';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'READY_FOR_FULFILMENT';

ALTER TABLE "partners"
  ADD COLUMN "can_verify_payments" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "orders"
  ADD COLUMN "payment_exception_type" "PaymentExceptionType" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "verified_gross_fiat_kobo" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "funding_cycle" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "commission_ledger_entries"
  ADD COLUMN "funding_cycle" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX "commission_ledger_entries_commission_record_id_funding_cycle_entry_type_key"
  ON "commission_ledger_entries"("commission_record_id", "funding_cycle", "entry_type");

CREATE TABLE "receiving_bank_accounts" (
  "id" UUID NOT NULL,
  "bank_name" TEXT NOT NULL,
  "bank_code" TEXT,
  "account_number" TEXT NOT NULL,
  "account_name" TEXT NOT NULL,
  "owner_partner_id" UUID NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "receiving_bank_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receiving_bank_accounts_bank_name_account_number_key" ON "receiving_bank_accounts"("bank_name", "account_number");
CREATE INDEX "receiving_bank_accounts_owner_partner_id_is_active_idx" ON "receiving_bank_accounts"("owner_partner_id", "is_active");

ALTER TABLE "receiving_bank_accounts"
  ADD CONSTRAINT "receiving_bank_accounts_owner_partner_id_fkey"
  FOREIGN KEY ("owner_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_bank_accounts"
  ADD CONSTRAINT "receiving_bank_accounts_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "receiving_bank_account_change_requests" (
  "id" UUID NOT NULL,
  "receiving_bank_account_id" UUID,
  "owner_partner_id" UUID NOT NULL,
  "requested_by_user_id" UUID NOT NULL,
  "confirmed_by_user_id" UUID,
  "action_type" TEXT NOT NULL,
  "proposed_data" JSONB NOT NULL,
  "status" "BankAccountChangeRequestStatus" NOT NULL DEFAULT 'PENDING_PARTNER_CONFIRMATION',
  "request_reason" TEXT NOT NULL,
  "confirmation_reason" TEXT,
  "confirmed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "receiving_bank_account_change_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "receiving_bank_account_change_requests_owner_partner_id_status_idx"
  ON "receiving_bank_account_change_requests"("owner_partner_id", "status");

ALTER TABLE "receiving_bank_account_change_requests"
  ADD CONSTRAINT "receiving_bank_account_change_requests_receiving_bank_account_id_fkey"
  FOREIGN KEY ("receiving_bank_account_id") REFERENCES "receiving_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_bank_account_change_requests"
  ADD CONSTRAINT "receiving_bank_account_change_requests_owner_partner_id_fkey"
  FOREIGN KEY ("owner_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_bank_account_change_requests"
  ADD CONSTRAINT "receiving_bank_account_change_requests_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_bank_account_change_requests"
  ADD CONSTRAINT "receiving_bank_account_change_requests_confirmed_by_user_id_fkey"
  FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_proofs"
  ADD COLUMN "receiving_bank_account_id" UUID,
  ADD COLUMN "submitted_by_user_id" UUID,
  ADD COLUMN "bank_name" TEXT,
  ADD COLUMN "transfer_timestamp" TIMESTAMP(3),
  ADD COLUMN "proof_mime_type" TEXT,
  ADD COLUMN "proof_sha256" TEXT,
  ADD COLUMN "is_split_transfer" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "payment_proofs"
  ADD CONSTRAINT "payment_proofs_receiving_bank_account_id_fkey"
  FOREIGN KEY ("receiving_bank_account_id") REFERENCES "receiving_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_proofs"
  ADD CONSTRAINT "payment_proofs_submitted_by_user_id_fkey"
  FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "bank_statement_uploads" (
  "id" UUID NOT NULL,
  "receiving_bank_account_id" UUID NOT NULL,
  "uploaded_by_user_id" UUID NOT NULL,
  "file_name" TEXT NOT NULL,
  "format" "BankStatementFormat" NOT NULL,
  "redacted_batch_sha256" TEXT NOT NULL,
  "period_start" TIMESTAMP(3),
  "period_end" TIMESTAMP(3),
  "line_count" INTEGER NOT NULL,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bank_statement_uploads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bank_statement_uploads_receiving_bank_account_id_created_at_idx"
  ON "bank_statement_uploads"("receiving_bank_account_id", "created_at");

ALTER TABLE "bank_statement_uploads"
  ADD CONSTRAINT "bank_statement_uploads_receiving_bank_account_id_fkey"
  FOREIGN KEY ("receiving_bank_account_id") REFERENCES "receiving_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_statement_uploads"
  ADD CONSTRAINT "bank_statement_uploads_uploaded_by_user_id_fkey"
  FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "bank_statement_lines" (
  "id" UUID NOT NULL,
  "statement_upload_id" UUID NOT NULL,
  "receiving_bank_account_id" UUID NOT NULL,
  "transaction_reference" TEXT NOT NULL,
  "transaction_reference_normalized" TEXT NOT NULL,
  "amount_kobo" BIGINT NOT NULL,
  "credited_at" TIMESTAMP(3) NOT NULL,
  "sender_name" TEXT,
  "narration" TEXT,
  "reconciliation_status" "BankStatementLineStatus" NOT NULL DEFAULT 'UNMATCHED',
  "linked_order_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_bank_statement_lines_positive_amount" CHECK ("amount_kobo" > 0)
);

CREATE UNIQUE INDEX "bank_statement_lines_receiving_bank_account_id_transaction_reference_normalized_key"
  ON "bank_statement_lines"("receiving_bank_account_id", "transaction_reference_normalized");
CREATE INDEX "bank_statement_lines_linked_order_id_idx" ON "bank_statement_lines"("linked_order_id");
CREATE INDEX "bank_statement_lines_reconciliation_status_receiving_bank_account_id_idx"
  ON "bank_statement_lines"("reconciliation_status", "receiving_bank_account_id");

ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_statement_upload_id_fkey"
  FOREIGN KEY ("statement_upload_id") REFERENCES "bank_statement_uploads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_receiving_bank_account_id_fkey"
  FOREIGN KEY ("receiving_bank_account_id") REFERENCES "receiving_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_linked_order_id_fkey"
  FOREIGN KEY ("linked_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "payment_verification_decisions" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "payment_proof_id" UUID,
  "receiving_bank_account_id" UUID,
  "verifier_user_id" UUID NOT NULL,
  "verifier_role" "UserRole" NOT NULL,
  "decision" "VerificationDecisionType" NOT NULL,
  "exception_type" "PaymentExceptionType" NOT NULL DEFAULT 'NONE',
  "bank_credit_confirmed" BOOLEAN NOT NULL DEFAULT false,
  "bank_credit_reference" TEXT,
  "bank_credit_reference_normalized" TEXT,
  "bank_credit_amount_kobo" BIGINT,
  "bank_credit_timestamp" TIMESTAMP(3),
  "is_manual_without_statement" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT NOT NULL,
  "supersedes_decision_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payment_verification_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_verification_decisions_order_id_created_at_idx" ON "payment_verification_decisions"("order_id", "created_at");
CREATE INDEX "payment_verification_decisions_supersedes_decision_id_idx" ON "payment_verification_decisions"("supersedes_decision_id");

-- Permanent bank-credit reference deduplication on APPROVED decisions (never recycled even after reversal)
CREATE UNIQUE INDEX "uq_pvd_approved_bank_ref"
  ON "payment_verification_decisions"("receiving_bank_account_id", "bank_credit_reference_normalized")
  WHERE "decision" = 'APPROVED' AND "bank_credit_reference_normalized" IS NOT NULL;

-- Single-reversal guarantee per APPROVED decision
CREATE UNIQUE INDEX "uq_pvd_single_reversal"
  ON "payment_verification_decisions"("supersedes_decision_id")
  WHERE "decision" = 'REVERSED' AND "supersedes_decision_id" IS NOT NULL;

ALTER TABLE "payment_verification_decisions"
  ADD CONSTRAINT "payment_verification_decisions_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_verification_decisions"
  ADD CONSTRAINT "payment_verification_decisions_payment_proof_id_fkey"
  FOREIGN KEY ("payment_proof_id") REFERENCES "payment_proofs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_verification_decisions"
  ADD CONSTRAINT "payment_verification_decisions_receiving_bank_account_id_fkey"
  FOREIGN KEY ("receiving_bank_account_id") REFERENCES "receiving_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_verification_decisions"
  ADD CONSTRAINT "payment_verification_decisions_verifier_user_id_fkey"
  FOREIGN KEY ("verifier_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "payment_decision_statement_lines" (
  "id" UUID NOT NULL,
  "decision_id" UUID NOT NULL,
  "statement_line_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "allocated_amount_kobo" BIGINT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payment_decision_statement_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_pdsl_positive_amount" CHECK ("allocated_amount_kobo" > 0)
);

-- Permanent statement-line allocation uniqueness: a statement line can only ever belong to one decision/order
CREATE UNIQUE INDEX "payment_decision_statement_lines_statement_line_id_key" ON "payment_decision_statement_lines"("statement_line_id");
CREATE UNIQUE INDEX "payment_decision_statement_lines_decision_id_statement_line_id_key" ON "payment_decision_statement_lines"("decision_id", "statement_line_id");
CREATE INDEX "payment_decision_statement_lines_order_id_idx" ON "payment_decision_statement_lines"("order_id");

ALTER TABLE "payment_decision_statement_lines"
  ADD CONSTRAINT "payment_decision_statement_lines_decision_id_fkey"
  FOREIGN KEY ("decision_id") REFERENCES "payment_verification_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_decision_statement_lines"
  ADD CONSTRAINT "payment_decision_statement_lines_statement_line_id_fkey"
  FOREIGN KEY ("statement_line_id") REFERENCES "bank_statement_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_decision_statement_lines"
  ADD CONSTRAINT "payment_decision_statement_lines_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "notifications" (
  "id" UUID NOT NULL,
  "recipient_user_id" UUID NOT NULL,
  "type" "NotificationType" NOT NULL,
  "order_id" UUID,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_recipient_user_id_read_at_created_at_idx" ON "notifications"("recipient_user_id", "read_at", "created_at");

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_recipient_user_id_fkey"
  FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

