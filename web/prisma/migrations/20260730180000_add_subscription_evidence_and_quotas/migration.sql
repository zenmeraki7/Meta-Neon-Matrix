-- AlterTable
ALTER TABLE "RecurringEditRun"
  ADD COLUMN IF NOT EXISTS "entitlementPlanKey" TEXT,
  ADD COLUMN IF NOT EXISTS "entitlementStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "entitlementCheckedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "entitlementVersion" BIGINT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ShopFeatureQuota" (
    "shop" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "used" INTEGER NOT NULL,
    "limit" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopFeatureQuota_pkey" PRIMARY KEY ("shop","feature")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AutomaticRuleRunQuota" (
    "shop" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "bucketHour" TIMESTAMP(3) NOT NULL,
    "used" INTEGER NOT NULL,
    "limit" INTEGER NOT NULL,

    CONSTRAINT "AutomaticRuleRunQuota_pkey" PRIMARY KEY ("shop","ruleId","bucketHour")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AutomaticProductRuleRun_one_active_per_rule_uq"
ON "AutomaticProductRuleRun" ("shop", "automaticProductRuleId")
WHERE "status" IN (
  'TARGET_FREEZE_QUEUED',
  'TARGET_FREEZING',
  'TARGET_FROZEN',
  'EXECUTING',
  'VERIFYING',
  'UNDO_PENDING',
  'UNDO_EXECUTING'
);
