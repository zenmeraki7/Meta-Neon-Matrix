-- Automatic/scheduled runs have an execution dedupe identity but do not always
-- originate from a replayable client request. NULL therefore means "no client
-- request identity"; PostgreSQL's unique index still protects non-NULL keys.
ALTER TABLE "AutomaticProductRuleRun"
  ALTER COLUMN "idempotencyKey" DROP NOT NULL;
