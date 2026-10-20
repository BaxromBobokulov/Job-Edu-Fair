-- HR scanner (Part 4): company name, HR user binding, check-in, decision history.
-- Company / HrUser / ScanEvent were stubs nothing wrote to, so NOT NULL columns
-- are added without defaults.

-- CreateEnum
CREATE TYPE "ScanDecision" AS ENUM ('interview', 'internship', 'reserve');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "HrUser" ADD COLUMN     "telegramId" BIGINT NOT NULL,
ADD COLUMN     "languageCode" "LanguageCode" NOT NULL,
ADD COLUMN     "addedBy" BIGINT NOT NULL,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Participant" ADD COLUMN     "checkedInAt" TIMESTAMP(3),
ADD COLUMN     "checkedInById" TEXT;

-- AlterTable
ALTER TABLE "ScanEvent" ADD COLUMN     "seq" SERIAL NOT NULL,
ADD COLUMN     "decision" "ScanDecision" NOT NULL,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE UNIQUE INDEX "Company_name_key" ON "Company"("name");

-- CreateIndex
CREATE UNIQUE INDEX "HrUser_telegramId_key" ON "HrUser"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "ScanEvent_seq_key" ON "ScanEvent"("seq");

-- CreateIndex
CREATE INDEX "ScanEvent_participantId_companyId_createdAt_idx" ON "ScanEvent"("participantId", "companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_checkedInById_fkey" FOREIGN KEY ("checkedInById") REFERENCES "HrUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
