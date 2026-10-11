CREATE TYPE "document_type" AS ENUM ('PUR', 'RDA');

ALTER TABLE "documents"
ADD COLUMN "document_type" "document_type" NOT NULL DEFAULT 'PUR',
ADD COLUMN "user_id" UUID,
ADD COLUMN "topics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "questions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "summary_level" TEXT NOT NULL DEFAULT 'balanced',
ADD COLUMN "summary" TEXT;

ALTER TABLE "documents"
ALTER COLUMN "ocr_status" SET DEFAULT 'UPLOADED';

CREATE INDEX "documents_user_id_document_type_idx" ON "documents"("user_id", "document_type");
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
