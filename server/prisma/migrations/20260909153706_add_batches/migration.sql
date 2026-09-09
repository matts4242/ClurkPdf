-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "batchId" UUID;

-- CreateTable
CREATE TABLE "Batch" (
    "id" UUID NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Batch_createdAt_idx" ON "Batch"("createdAt");

-- CreateIndex
CREATE INDEX "Document_batchId_idx" ON "Document"("batchId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
