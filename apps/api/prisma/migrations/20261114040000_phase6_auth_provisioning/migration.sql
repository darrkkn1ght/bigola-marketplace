-- CreateEnum
CREATE TYPE "AccountTokenType" AS ENUM ('PASSWORD_RESET', 'PARTNER_INVITE');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "account_action_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "type" "AccountTokenType" NOT NULL,
    "issued_by_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_action_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_action_tokens_token_hash_key" ON "account_action_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "account_action_tokens_user_id_type_used_at_idx" ON "account_action_tokens"("user_id", "type", "used_at");

-- AddForeignKey
ALTER TABLE "account_action_tokens" ADD CONSTRAINT "account_action_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_action_tokens" ADD CONSTRAINT "account_action_tokens_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
