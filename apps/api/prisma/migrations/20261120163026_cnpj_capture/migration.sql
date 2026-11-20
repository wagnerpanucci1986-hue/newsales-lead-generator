-- CreateEnum
CREATE TYPE "LegalBasis" AS ENUM ('CONSENT', 'LEGITIMATE_INTEREST');

-- CreateEnum
CREATE TYPE "CnpjImportStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "legalBasis" "LegalBasis";

-- CreateTable
CREATE TABLE "CnpjEstablishment" (
    "cnpj" TEXT NOT NULL,
    "cnpjBase" TEXT NOT NULL,
    "isMatriz" BOOLEAN NOT NULL,
    "nomeFantasia" TEXT,
    "cnaePrincipal" TEXT NOT NULL,
    "cnaesSecundarios" TEXT[],
    "uf" TEXT NOT NULL,
    "municipioCodigo" TEXT NOT NULL,
    "municipio" TEXT,
    "bairro" TEXT,
    "cep" TEXT,
    "endereco" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "hasMobile" BOOLEAN NOT NULL DEFAULT false,
    "email" TEXT,
    "dataInicio" DATE,
    "importId" TEXT NOT NULL,

    CONSTRAINT "CnpjEstablishment_pkey" PRIMARY KEY ("cnpj")
);

-- CreateTable
CREATE TABLE "CnpjCompany" (
    "cnpjBase" TEXT NOT NULL,
    "razaoSocial" TEXT NOT NULL,
    "naturezaJuridica" TEXT,
    "capitalSocial" DOUBLE PRECISION,
    "porte" TEXT,
    "isMei" BOOLEAN NOT NULL DEFAULT false,
    "isSimples" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CnpjCompany_pkey" PRIMARY KEY ("cnpjBase")
);

-- CreateTable
CREATE TABLE "CnpjCnae" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "CnpjCnae_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "CnpjMunicipio" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "CnpjMunicipio_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "CnpjNatureza" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "CnpjNatureza_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "CnpjImport" (
    "id" TEXT NOT NULL,
    "status" "CnpjImportStatus" NOT NULL DEFAULT 'RUNNING',
    "ufs" TEXT[],
    "source" TEXT,
    "competencia" TEXT,
    "progress" TEXT,
    "stats" JSONB,
    "error" TEXT,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CnpjImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CnpjEstablishment_uf_municipioCodigo_idx" ON "CnpjEstablishment"("uf", "municipioCodigo");

-- CreateIndex
CREATE INDEX "CnpjEstablishment_cnaePrincipal_idx" ON "CnpjEstablishment"("cnaePrincipal");

-- CreateIndex
CREATE INDEX "CnpjEstablishment_cnaesSecundarios_idx" ON "CnpjEstablishment" USING GIN ("cnaesSecundarios");

-- CreateIndex
CREATE INDEX "CnpjEstablishment_cnpjBase_idx" ON "CnpjEstablishment"("cnpjBase");

-- CreateIndex
CREATE INDEX "CnpjEstablishment_importId_idx" ON "CnpjEstablishment"("importId");

-- CreateIndex
CREATE INDEX "CnpjCompany_porte_idx" ON "CnpjCompany"("porte");

-- CreateIndex
CREATE INDEX "CnpjCompany_capitalSocial_idx" ON "CnpjCompany"("capitalSocial");

-- CreateIndex
CREATE INDEX "CnpjImport_startedAt_idx" ON "CnpjImport"("startedAt");
