-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('VENDOR_NAME', 'VENDOR_ADDRESS', 'INVOICE_NUMBER', 'INVOICE_DATE', 'DUE_DATE', 'PO_NUMBER', 'SUBTOTAL', 'TAX', 'TOTAL', 'LINE_ITEMS', 'CUSTOM');

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "uploadPath" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "fieldType" "FieldType" NOT NULL,
    "fieldLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_status_idx" ON "Document"("status");

-- CreateIndex
CREATE INDEX "Document_createdAt_idx" ON "Document"("createdAt");

-- CreateIndex
CREATE INDEX "Region_documentId_idx" ON "Region"("documentId");

-- CreateIndex
CREATE INDEX "Region_documentId_pageNumber_idx" ON "Region"("documentId", "pageNumber");

-- CreateIndex
CREATE INDEX "Region_fieldType_idx" ON "Region"("fieldType");

-- AddForeignKey
ALTER TABLE "Region" ADD CONSTRAINT "Region_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
