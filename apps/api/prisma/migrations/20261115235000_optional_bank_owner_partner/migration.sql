-- AlterTable
ALTER TABLE "receiving_bank_accounts" ALTER COLUMN "owner_partner_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "receiving_bank_account_change_requests" ALTER COLUMN "owner_partner_id" DROP NOT NULL;
