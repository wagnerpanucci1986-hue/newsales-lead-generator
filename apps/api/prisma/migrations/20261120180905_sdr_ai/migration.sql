-- CreateEnum
CREATE TYPE "AiStatus" AS ENUM ('OFF', 'ACTIVE', 'DONE');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('ABERTURA', 'DESCOBERTA', 'CONEXAO', 'CONVITE', 'AGENDADO', 'ENCERRADO');

-- CreateEnum
CREATE TYPE "LeadTemperature" AS ENUM ('QUENTE', 'MORNO', 'FRIO');

-- AlterEnum
ALTER TYPE "MessageSource" ADD VALUE 'AI';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "sdrEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "variants" TEXT[];

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "aiStatus" "AiStatus" NOT NULL DEFAULT 'OFF';

-- CreateTable
CREATE TABLE "SdrLead" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "campaignId" TEXT,
    "stage" "LeadStage" NOT NULL DEFAULT 'ABERTURA',
    "temperature" "LeadTemperature",
    "cargo" TEXT,
    "produto" TEXT,
    "estados" TEXT,
    "porte" TEXT,
    "experiencia" TEXT,
    "dor" TEXT,
    "objecoes" TEXT[],
    "melhorHorario" TEXT,
    "email" TEXT,
    "proximoPasso" TEXT,
    "motivo" TEXT,
    "followUpCount" INTEGER NOT NULL DEFAULT 0,
    "nextFollowUpAt" TIMESTAMP(3),
    "meetingStart" TIMESTAMP(3),
    "meetingEnd" TIMESTAMP(3),
    "meetingEventId" TEXT,
    "meetingLink" TEXT,
    "consultantName" TEXT,
    "consultantEmail" TEXT,
    "remindedDayBefore" BOOLEAN NOT NULL DEFAULT false,
    "remindedSameDay" BOOLEAN NOT NULL DEFAULT false,
    "handoffTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SdrLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SdrRun" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reply" TEXT,
    "toolCalls" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SdrRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SdrLead_conversationId_key" ON "SdrLead"("conversationId");

-- CreateIndex
CREATE INDEX "SdrLead_nextFollowUpAt_idx" ON "SdrLead"("nextFollowUpAt");

-- CreateIndex
CREATE INDEX "SdrLead_meetingStart_idx" ON "SdrLead"("meetingStart");

-- CreateIndex
CREATE INDEX "SdrLead_temperature_stage_idx" ON "SdrLead"("temperature", "stage");

-- CreateIndex
CREATE INDEX "SdrRun_conversationId_createdAt_idx" ON "SdrRun"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "SdrRun_createdAt_idx" ON "SdrRun"("createdAt");

-- AddForeignKey
ALTER TABLE "SdrLead" ADD CONSTRAINT "SdrLead_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SdrRun" ADD CONSTRAINT "SdrRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
