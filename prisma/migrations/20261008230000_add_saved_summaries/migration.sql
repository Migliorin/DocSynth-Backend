CREATE TABLE "document_summaries" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "topics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "questions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "summary_level" TEXT NOT NULL DEFAULT 'balanced',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_summaries_pkey" PRIMARY KEY ("id")
);

INSERT INTO "document_summaries" ("id", "document_id", "content", "topics", "questions", "summary_level", "created_at")
SELECT gen_random_uuid(), "id", "summary", "topics", "questions", "summary_level", "created_at"
FROM "documents"
WHERE "summary" IS NOT NULL;

ALTER TABLE "documents" DROP COLUMN "summary";

CREATE INDEX "document_summaries_document_id_created_at_idx"
ON "document_summaries"("document_id", "created_at");

ALTER TABLE "document_summaries"
ADD CONSTRAINT "document_summaries_document_id_fkey"
FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
