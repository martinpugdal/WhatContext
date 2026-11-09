-- CreateEnum
CREATE TYPE "SummaryKind" AS ENUM ('CHUNK', 'CATCHUP');

-- AlterTable
ALTER TABLE "Summary"
    ADD COLUMN "kind" "SummaryKind" NOT NULL DEFAULT 'CATCHUP',
    ADD COLUMN "messageCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastMessageId" TEXT;

-- DropIndex
DROP INDEX IF EXISTS "Summary_guildId_channelId_createdAt_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Summary_channelId_kind_windowStart_windowEnd_key" ON "Summary"("channelId", "kind", "windowStart", "windowEnd");

-- CreateIndex
CREATE INDEX "Summary_guildId_channelId_kind_createdAt_idx" ON "Summary"("guildId", "channelId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "Summary_channelId_kind_windowEnd_idx" ON "Summary"("channelId", "kind", "windowEnd");
