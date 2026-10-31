-- AlterTable
ALTER TABLE "Job" ADD COLUMN "linkedinUrl" TEXT;

-- Keep the LinkedIn link of jobs added before this column existed.
UPDATE "Job" SET "linkedinUrl" = "applyUrl" WHERE "applyUrl" ~* '^https?://([a-z0-9-]+\.)*linkedin\.com(/|$)';
UPDATE "Job" SET "linkedinUrl" = "url" WHERE "linkedinUrl" IS NULL AND "url" ~* '^https?://([a-z0-9-]+\.)*linkedin\.com(/|$)';
