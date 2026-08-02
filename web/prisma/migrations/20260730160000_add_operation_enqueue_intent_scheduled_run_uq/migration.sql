-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OperationEnqueueIntent_scheduled_run_uq"
ON "OperationEnqueueIntent" ("shop", "dedupeKey")
WHERE "dedupeKey" IS NOT NULL;
