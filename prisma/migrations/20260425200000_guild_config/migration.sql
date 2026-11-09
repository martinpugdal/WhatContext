-- CreateEnum
CREATE TYPE "LlmProvider" AS ENUM ('LOCAL', 'OPENAI');

-- CreateTable
CREATE TABLE "GuildConfig" (
    "guildId" TEXT NOT NULL,
    "provider" "LlmProvider" NOT NULL DEFAULT 'LOCAL',
    "encryptedKey" TEXT,
    "model" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuildConfig_pkey" PRIMARY KEY ("guildId")
);
