-- Automatic rule lifecycle alignment migration

-- 1) Expand rule status enum and migrate values.

ALTER TABLE "AutomaticProductRule" ALTER COLUMN "status" DROP DEFAULT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutomaticProductRuleStatus') THEN
    ALTER TYPE "AutomaticProductRuleStatus" RENAME TO "AutomaticProductRuleStatus_old";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutomaticProductRuleStatus') THEN
    CREATE TYPE "AutomaticProductRuleStatus" AS ENUM ('DRAFT','ACTIVE','PAUSED','DELETED');
  END IF;
END $$;

ALTER TABLE "AutomaticProductRule"
  ALTER COLUMN "status" TYPE "AutomaticProductRuleStatus"
  USING (
    CASE
      WHEN "status"::text = 'FAILED' THEN 'PAUSED'::"AutomaticProductRuleStatus"
      WHEN "status"::text = 'CANCELLED' THEN 'DELETED'::"AutomaticProductRuleStatus"
      ELSE "status"::text::"AutomaticProductRuleStatus"
    END
  );

ALTER TABLE "AutomaticProductRule"
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"AutomaticProductRuleStatus";

DROP TYPE IF EXISTS "AutomaticProductRuleStatus_old";


-- 2) Expand run status enum and migrate values.

ALTER TABLE "AutomaticProductRuleRun" ALTER COLUMN "status" DROP DEFAULT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutomaticProductRuleRunStatus') THEN
    ALTER TYPE "AutomaticProductRuleRunStatus" RENAME TO "AutomaticProductRuleRunStatus_old";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutomaticProductRuleRunStatus') THEN
    CREATE TYPE "AutomaticProductRuleRunStatus" AS ENUM (
      'TARGET_FREEZE_QUEUED',
      'TARGET_FREEZING',
      'TARGET_FROZEN',
      'EXECUTING',
      'VERIFYING',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'UNDO_PENDING',
      'UNDO_EXECUTING'
    );
  END IF;
END $$;

ALTER TABLE "AutomaticProductRuleRun"
  ALTER COLUMN "status" TYPE "AutomaticProductRuleRunStatus"
  USING (
    CASE
      WHEN "status"::text = 'PENDING' THEN 'TARGET_FREEZE_QUEUED'::"AutomaticProductRuleRunStatus"
      WHEN "status"::text = 'PROCESSING' THEN 'EXECUTING'::"AutomaticProductRuleRunStatus"
      WHEN "status"::text = 'SUCCESS' THEN 'SUCCEEDED'::"AutomaticProductRuleRunStatus"
      WHEN "status"::text = 'SKIPPED' THEN 'CANCELLED'::"AutomaticProductRuleRunStatus"
      ELSE "status"::text::"AutomaticProductRuleRunStatus"
    END
  );

ALTER TABLE "AutomaticProductRuleRun"
  ALTER COLUMN "status" SET DEFAULT 'TARGET_FREEZE_QUEUED'::"AutomaticProductRuleRunStatus";

DROP TYPE IF EXISTS "AutomaticProductRuleRunStatus_old";