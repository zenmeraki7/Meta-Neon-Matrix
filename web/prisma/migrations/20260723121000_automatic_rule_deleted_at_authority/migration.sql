UPDATE "AutomaticProductRule"
SET "deletedAt" = COALESCE("deletedAt", "updatedAt", NOW()),
    "isDeleted" = true
WHERE "deletedAt" IS NOT NULL
   OR COALESCE("isDeleted", false)
   OR "status" = 'DELETED'::"AutomaticProductRuleStatus";

-- Preserve a valid non-deletion lifecycle value. deletedAt alone owns soft deletion.
UPDATE "AutomaticProductRule"
SET "status" = 'PAUSED'::"AutomaticProductRuleStatus"
WHERE "status" = 'DELETED'::"AutomaticProductRuleStatus";

DROP INDEX IF EXISTS "AutomaticProductRule_shop_isDeleted_idx";
DROP INDEX IF EXISTS "AutomaticProductRule_shop_status_isDeleted_idx";
DROP INDEX IF EXISTS "AutomaticProductRule_active_due_idx";
DROP INDEX IF EXISTS "automatic_product_rule_due_idx";

CREATE INDEX IF NOT EXISTS "automatic_product_rule_due_idx"
ON "AutomaticProductRule" ("priority", "nextRunAt", "createdAt", "id")
WHERE "status" = 'ACTIVE'::"AutomaticProductRuleStatus"
  AND "deletedAt" IS NULL
  AND "schedulerDisabledAt" IS NULL
  AND "nextRunAt" IS NOT NULL;
