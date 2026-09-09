-- CreateEnum
CREATE TYPE "TextSource" AS ENUM ('NONE', 'OCR', 'TEXT_LAYER');

-- AlterTable
ALTER TABLE "Region" ADD COLUMN     "textSource" "TextSource" NOT NULL DEFAULT 'NONE';
