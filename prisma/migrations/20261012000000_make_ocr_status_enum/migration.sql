CREATE TYPE "ocr_status" AS ENUM (
  'QUEUED',
  'EXTRACTING',
  'EXTRACTED',
  'SUMMARIZING',
  'CANCELLING',
  'CANCELLED',
  'COMPLETED',
  'FAILED'
);

UPDATE "documents" SET "ocr_status" = 'QUEUED' WHERE "ocr_status" = 'UPLOADED';

ALTER TABLE "documents"
ALTER COLUMN "ocr_status" DROP DEFAULT,
ALTER COLUMN "ocr_status" TYPE "ocr_status" USING "ocr_status"::"ocr_status",
ALTER COLUMN "ocr_status" SET DEFAULT 'QUEUED';
