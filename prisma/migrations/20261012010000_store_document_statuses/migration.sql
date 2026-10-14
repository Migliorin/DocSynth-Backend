CREATE TABLE "document_statuses" (
  "id" SERIAL NOT NULL,
  "code" TEXT NOT NULL,
  CONSTRAINT "document_statuses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_statuses_code_key" UNIQUE ("code")
);

INSERT INTO "document_statuses" ("id", "code") VALUES
  (1, 'QUEUED'),
  (2, 'EXTRACTING'),
  (3, 'EXTRACTED'),
  (4, 'SUMMARIZING'),
  (5, 'CANCELLING'),
  (6, 'CANCELLED'),
  (7, 'COMPLETED'),
  (8, 'FAILED');
SELECT setval(pg_get_serial_sequence('document_statuses', 'id'), 8, true);

ALTER TABLE "documents" ADD COLUMN "ocr_status_id" INTEGER;
UPDATE "documents" AS document
SET "ocr_status_id" = status."id"
FROM "document_statuses" AS status
WHERE status."code" = document."ocr_status"::TEXT;
ALTER TABLE "documents" ALTER COLUMN "ocr_status_id" SET NOT NULL;
ALTER TABLE "documents"
ADD CONSTRAINT "documents_ocr_status_id_fkey"
FOREIGN KEY ("ocr_status_id") REFERENCES "document_statuses"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents" DROP COLUMN "ocr_status";
DROP TYPE "ocr_status";
