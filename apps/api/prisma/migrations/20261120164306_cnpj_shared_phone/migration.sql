-- AlterTable
ALTER TABLE "CnpjEstablishment" ADD COLUMN     "phoneShared" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "CnpjEstablishment_phoneShared_idx" ON "CnpjEstablishment"("phoneShared");
