-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "googleReviewUrl" TEXT;

-- AlterTable
ALTER TABLE "notification_logs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "notification_logs_dedupeKey_key" ON "notification_logs"("dedupeKey");

