/*
  Warnings:

  - Added the required column `languageCode` to the `Participant` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "LanguageCode" AS ENUM ('uz', 'ru', 'en');

-- AlterTable
ALTER TABLE "Participant" ADD COLUMN     "languageCode" "LanguageCode" NOT NULL;
