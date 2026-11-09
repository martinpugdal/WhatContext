-- AlterTable Decision
ALTER TABLE "Decision"
    ADD COLUMN "supersededAt" TIMESTAMP(3),
    ADD COLUMN "supersededById" TEXT;

-- CreateIndex Decision
CREATE INDEX "Decision_channelId_supersededAt_idx" ON "Decision"("channelId", "supersededAt");

-- AlterTable OpenQuestion
ALTER TABLE "OpenQuestion"
    ADD COLUMN "resolvedAt" TIMESTAMP(3),
    ADD COLUMN "resolvedById" TEXT;

-- CreateIndex OpenQuestion
CREATE INDEX "OpenQuestion_channelId_resolved_idx" ON "OpenQuestion"("channelId", "resolved");
