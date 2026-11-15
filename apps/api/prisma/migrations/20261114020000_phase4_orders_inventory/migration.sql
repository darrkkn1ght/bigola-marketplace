-- Phase 4: Orders, Configurable Pricing, Inventory Freshness & Transaction-Safe Reservations

CREATE TYPE "OrderChannel" AS ENUM ('ONLINE', 'OFFLINE_PARTNER', 'OFFLINE_OWNER');
CREATE TYPE "OrderType" AS ENUM ('BULK', 'RETAIL');
CREATE TYPE "InventoryReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED');

ALTER TYPE "GameAccountHealth" ADD VALUE IF NOT EXISTS 'STALE';

ALTER TABLE "orders"
  ADD COLUMN "channel" "OrderChannel" NOT NULL DEFAULT 'ONLINE',
  ADD COLUMN "order_type" "OrderType" NOT NULL DEFAULT 'BULK',
  ADD COLUMN "created_by_user_id" UUID,
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "idempotency_request_hash" TEXT;

CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders"("idempotency_key");
CREATE INDEX "orders_status_expires_at_idx" ON "orders"("status", "expires_at");

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "game_accounts"
  ADD COLUMN "logical_allocation_amount" DECIMAL(30, 0) NOT NULL DEFAULT 0;

ALTER TABLE "game_accounts"
  ADD CONSTRAINT "chk_game_accounts_non_negative_balance" CHECK ("last_known_balance" >= 0),
  ADD CONSTRAINT "chk_game_accounts_non_negative_reserved" CHECK ("reserved_for_orders" >= 0),
  ADD CONSTRAINT "chk_game_accounts_no_oversell" CHECK ("reserved_for_orders" <= "last_known_balance"),
  ADD CONSTRAINT "chk_game_accounts_non_negative_logical_alloc" CHECK ("logical_allocation_amount" >= 0);

CREATE TABLE "inventory_reservations" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "game_account_id" UUID NOT NULL,
  "amount" DECIMAL(30, 0) NOT NULL,
  "status" "InventoryReservationStatus" NOT NULL DEFAULT 'ACTIVE',
  "expires_at" TIMESTAMP(3),
  "released_at" TIMESTAMP(3),
  "release_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_inventory_reservations_positive_amount" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "inventory_reservations_order_id_game_account_id_key" ON "inventory_reservations"("order_id", "game_account_id");
CREATE INDEX "inventory_reservations_game_account_id_status_idx" ON "inventory_reservations"("game_account_id", "status");

ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "inventory_reservations_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "inventory_reservations_game_account_id_fkey"
  FOREIGN KEY ("game_account_id") REFERENCES "game_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

