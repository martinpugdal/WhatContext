-- CreateTable
CREATE TABLE "WatchedChannel" (
    "channelId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchedChannel_pkey" PRIMARY KEY ("channelId")
);

-- CreateIndex
CREATE INDEX "WatchedChannel_guildId_idx" ON "WatchedChannel"("guildId");
