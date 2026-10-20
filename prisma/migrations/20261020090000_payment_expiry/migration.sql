-- DropIndex
DROP INDEX "Payment_participantId_key";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "expiredAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Payment_participantId_createdAt_idx" ON "Payment"("participantId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");


-- At most one non-expired payment per participant (partial index: not expressible in schema.prisma).
CREATE UNIQUE INDEX "Payment_one_active_per_participant" ON "Payment"("participantId") WHERE "status" <> 'expired';
