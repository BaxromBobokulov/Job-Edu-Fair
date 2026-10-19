-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'paid', 'refund_requested', 'refunded', 'expired');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "amount" INTEGER NOT NULL,
ADD COLUMN     "clickPrepareId" SERIAL NOT NULL,
ADD COLUMN     "clickTransId" BIGINT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "preparedAt" TIMESTAMP(3),
ADD COLUMN     "refundApprovedBy" BIGINT,
ADD COLUMN     "refundRequestedAt" TIMESTAMP(3),
ADD COLUMN     "refundRequestedBy" BIGINT,
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'pending';

-- CreateIndex
CREATE UNIQUE INDEX "Payment_participantId_key" ON "Payment"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_clickTransId_key" ON "Payment"("clickTransId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_clickPrepareId_key" ON "Payment"("clickPrepareId");

