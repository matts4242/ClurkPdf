-- CreateEnum
CREATE TYPE "OcrStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'ERROR');

-- AlterTable
ALTER TABLE "Region" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "correctedText" TEXT,
ADD COLUMN     "ocrAt" TIMESTAMP(3),
ADD COLUMN     "ocrError" TEXT,
ADD COLUMN     "ocrStatus" "OcrStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "rawText" TEXT;

-- CreateIndex
CREATE INDEX "Region_documentId_ocrStatus_idx" ON "Region"("documentId", "ocrStatus");
