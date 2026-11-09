-- AlterTable
ALTER TABLE "GuildConfig"
    DROP COLUMN "provider",
    ADD COLUMN "baseUrl" TEXT;

-- DropEnum
DROP TYPE "LlmProvider";
