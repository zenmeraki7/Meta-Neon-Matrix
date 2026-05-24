ALTER TABLE "AutomaticProductRuleRun"
  ADD COLUMN IF NOT EXISTS "ruleSnapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "conditionsSnapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "actionsSnapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "scopeTypeSnapshot" "AutomaticProductRuleScopeType",
  ADD COLUMN IF NOT EXISTS "applyModeSnapshot" TEXT;
