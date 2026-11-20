/*
  Warnings:

  - You are about to drop the column `deliveredCount` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `failedCount` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `optOutCount` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `readCount` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `repliedCount` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `sentCount` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `skippedCount` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `pausedUntil` on the `WaNumber` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "deliveredCount",
DROP COLUMN "failedCount",
DROP COLUMN "optOutCount",
DROP COLUMN "readCount",
DROP COLUMN "repliedCount",
DROP COLUMN "sentCount",
DROP COLUMN "skippedCount";

-- AlterTable
ALTER TABLE "WaNumber" DROP COLUMN "pausedUntil",
ADD COLUMN     "nextSendAt" TIMESTAMP(3),
ADD COLUMN     "resumedAt" TIMESTAMP(3);
