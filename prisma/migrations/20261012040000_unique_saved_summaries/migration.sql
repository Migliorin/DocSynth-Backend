ALTER TABLE "document_summaries" ADD COLUMN "generation_id" UUID;
UPDATE "document_summaries" SET "generation_id" = "id";
ALTER TABLE "document_summaries" ALTER COLUMN "generation_id" SET NOT NULL;
CREATE UNIQUE INDEX "document_summaries_document_id_generation_id_key"
  ON "document_summaries"("document_id", "generation_id");
