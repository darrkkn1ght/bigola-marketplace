-- AlterTable: Add unique permanent referral_code to users (for Owners)
ALTER TABLE "users" ADD COLUMN "referral_code" TEXT;

-- AlterTable: Add attributed_owner_user_id to customers
ALTER TABLE "customers" ADD COLUMN "attributed_owner_user_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "users_referral_code_key" ON "users"("referral_code");

-- CreateIndex
CREATE INDEX "customers_attributed_owner_user_id_idx" ON "customers"("attributed_owner_user_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_attributed_owner_user_id_fkey" FOREIGN KEY ("attributed_owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
