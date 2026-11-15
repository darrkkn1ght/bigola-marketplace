-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'PARTNER', 'OPS_ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CustomerCategory" AS ENUM ('CATEGORY_A_PARTNER', 'CATEGORY_B_BIGOLA');

-- CreateEnum
CREATE TYPE "AttributionSource" AS ENUM ('REF_LINK', 'REF_CODE', 'OWNER_OFFLINE', 'PARTNER_OFFLINE');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('AWAITING_PAYMENT', 'PROOF_SUBMITTED', 'PAYMENT_VERIFIED', 'QUEUED', 'DISBURSING', 'PARTIALLY_FULFILLED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ProofVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CommissionRuleStatus" AS ENUM ('PENDING_RULE', 'ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "CommissionSettlementStatus" AS ENUM ('PENDING_RULE', 'ACCRUED', 'SETTLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "GameAccountRole" AS ENUM ('MAIN_TREASURY', 'RESERVE');

-- CreateEnum
CREATE TYPE "GameAccountHealth" AS ENUM ('UNCONFIGURED', 'ACTIVE', 'COOLDOWN', 'SESSION_EXPIRED', 'LOW_BALANCE', 'DISABLED');

-- CreateEnum
CREATE TYPE "InventoryEntryType" AS ENUM ('TREASURY_SYNC', 'TREASURY_TO_RESERVE', 'ORDER_RESERVE', 'ORDER_RELEASE', 'DISBURSEMENT_DEBIT', 'MANUAL_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "DisbursementJobStatus" AS ENUM ('PENDING', 'RUNNING', 'PAUSED', 'PARTIAL', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "DisbursementChunkStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED_RETRYABLE', 'AMBIGUOUS_MANUAL_REVIEW', 'FAILED_TERMINAL');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "encrypted_totp_secret" TEXT,
    "recovery_code_hashes" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "referral_code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "PartnerStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "lagoslife_username" TEXT,
    "category" "CustomerCategory" NOT NULL DEFAULT 'CATEGORY_B_BIGOLA',
    "attributed_partner_id" UUID,
    "attributed_at" TIMESTAMP(3),
    "attribution_source" "AttributionSource",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_number" TEXT NOT NULL,
    "payment_reference" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "customer_category" "CustomerCategory" NOT NULL,
    "partner_id" UUID,
    "recipient_lagoslife_username" TEXT NOT NULL,
    "game_amount_requested" DECIMAL(30,0) NOT NULL,
    "game_amount_delivered" DECIMAL(30,0) NOT NULL DEFAULT 0,
    "fiat_amount_kobo" BIGINT NOT NULL,
    "pricing_snapshot" JSONB NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "expires_at" TIMESTAMP(3),
    "scheduled_window_start" TIMESTAMP(3),
    "scheduled_window_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_proofs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "bank_reference" TEXT NOT NULL,
    "sender_account_name" TEXT NOT NULL,
    "claimed_amount_kobo" BIGINT NOT NULL,
    "proof_file_key" TEXT NOT NULL,
    "verification_status" "ProofVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verified_by_id" UUID,
    "rejection_reason" TEXT,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_rules" (
    "id" UUID NOT NULL,
    "category" "CustomerCategory" NOT NULL,
    "status" "CommissionRuleStatus" NOT NULL DEFAULT 'PENDING_RULE',
    "partner_share_bps" INTEGER,
    "owner_share_bps" INTEGER,
    "configured_by_id" UUID,
    "notes" TEXT,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_records" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "partner_id" UUID,
    "category" "CustomerCategory" NOT NULL,
    "rule_id" UUID NOT NULL,
    "gross_fiat_kobo" BIGINT NOT NULL,
    "partner_entitlement_kobo" BIGINT,
    "owner_entitlement_kobo" BIGINT,
    "settlement_status" "CommissionSettlementStatus" NOT NULL,
    "settled_at" TIMESTAMP(3),
    "settlement_reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_accounts" (
    "id" UUID NOT NULL,
    "slot_code" TEXT NOT NULL,
    "lagoslife_username" TEXT,
    "account_role" "GameAccountRole" NOT NULL,
    "target_reserve_amount" DECIMAL(30,0) NOT NULL DEFAULT 0,
    "last_known_balance" DECIMAL(30,0) NOT NULL DEFAULT 0,
    "reserved_for_orders" DECIMAL(30,0) NOT NULL DEFAULT 0,
    "health_status" "GameAccountHealth" NOT NULL DEFAULT 'UNCONFIGURED',
    "encrypted_session_bundle" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_ledger" (
    "id" UUID NOT NULL,
    "game_account_id" UUID NOT NULL,
    "order_id" UUID,
    "entry_type" "InventoryEntryType" NOT NULL,
    "delta_amount" DECIMAL(30,0) NOT NULL,
    "balance_after" DECIMAL(30,0) NOT NULL,
    "created_by_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursement_jobs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "total_amount" DECIMAL(30,0) NOT NULL,
    "delivered_amount" DECIMAL(30,0) NOT NULL DEFAULT 0,
    "status" "DisbursementJobStatus" NOT NULL DEFAULT 'PENDING',
    "total_chunks" INTEGER NOT NULL,
    "completed_chunks" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disbursement_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursement_chunks" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "source_account_id" UUID NOT NULL,
    "recipient_username" TEXT NOT NULL,
    "amount" DECIMAL(30,0) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "DisbursementChunkStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "http_status" INTEGER,
    "error_message" TEXT,
    "reconciliation_note" TEXT,
    "executed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disbursement_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action_type" TEXT NOT NULL,
    "target_entity" TEXT NOT NULL,
    "target_id" TEXT,
    "before_state" JSONB,
    "after_state" JSONB,
    "reason" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_token_hash_key" ON "user_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "partners_user_id_key" ON "partners"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "partners_referral_code_key" ON "partners"("referral_code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_user_id_key" ON "customers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_key" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customers_attributed_partner_id_idx" ON "customers"("attributed_partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_payment_reference_key" ON "orders"("payment_reference");

-- CreateIndex
CREATE INDEX "orders_customer_id_status_idx" ON "orders"("customer_id", "status");

-- CreateIndex
CREATE INDEX "orders_partner_id_idx" ON "orders"("partner_id");

-- CreateIndex
CREATE INDEX "payment_proofs_order_id_idx" ON "payment_proofs"("order_id");

-- CreateIndex
CREATE INDEX "payment_proofs_bank_reference_claimed_amount_kobo_idx" ON "payment_proofs"("bank_reference", "claimed_amount_kobo");

-- CreateIndex
CREATE INDEX "commission_rules_category_status_idx" ON "commission_rules"("category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commission_records_order_id_key" ON "commission_records"("order_id");

-- CreateIndex
CREATE INDEX "commission_records_partner_id_settlement_status_idx" ON "commission_records"("partner_id", "settlement_status");

-- CreateIndex
CREATE UNIQUE INDEX "game_accounts_slot_code_key" ON "game_accounts"("slot_code");

-- CreateIndex
CREATE UNIQUE INDEX "game_accounts_lagoslife_username_key" ON "game_accounts"("lagoslife_username");

-- CreateIndex
CREATE INDEX "inventory_ledger_game_account_id_created_at_idx" ON "inventory_ledger"("game_account_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_ledger_order_id_idx" ON "inventory_ledger"("order_id");

-- CreateIndex
CREATE INDEX "disbursement_jobs_order_id_status_idx" ON "disbursement_jobs"("order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "disbursement_chunks_idempotency_key_key" ON "disbursement_chunks"("idempotency_key");

-- CreateIndex
CREATE INDEX "disbursement_chunks_job_id_status_idx" ON "disbursement_chunks"("job_id", "status");

-- CreateIndex
CREATE INDEX "disbursement_chunks_source_account_id_status_idx" ON "disbursement_chunks"("source_account_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_target_entity_target_id_idx" ON "audit_logs"("target_entity", "target_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_attributed_partner_id_fkey" FOREIGN KEY ("attributed_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_configured_by_id_fkey" FOREIGN KEY ("configured_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_records" ADD CONSTRAINT "commission_records_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_records" ADD CONSTRAINT "commission_records_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_records" ADD CONSTRAINT "commission_records_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "commission_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_game_account_id_fkey" FOREIGN KEY ("game_account_id") REFERENCES "game_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursement_jobs" ADD CONSTRAINT "disbursement_jobs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursement_chunks" ADD CONSTRAINT "disbursement_chunks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "disbursement_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursement_chunks" ADD CONSTRAINT "disbursement_chunks_source_account_id_fkey" FOREIGN KEY ("source_account_id") REFERENCES "game_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

