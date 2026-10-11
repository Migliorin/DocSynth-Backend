ALTER TABLE "documents"
ADD COLUMN "ocr_status" TEXT NOT NULL DEFAULT 'QUEUED',
ADD COLUMN "markdown_key" TEXT,
ADD COLUMN "ocr_error" TEXT;
