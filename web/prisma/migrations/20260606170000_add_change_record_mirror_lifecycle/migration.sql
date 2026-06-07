ALTER TABLE "ChangeRecord"
  ADD COLUMN IF NOT EXISTS "mirrorStatus" TEXT NOT NULL DEFAULT 'NOT_PENDING',
  ADD COLUMN IF NOT EXISTS "mirrorAppliedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ChangeRecord_shop_editHistoryId_mirrorStatus_idx"
  ON "ChangeRecord"("shop", "editHistoryId", "mirrorStatus");

UPDATE "ChangeRecord"
SET
  "mirrorStatus" = CASE
    WHEN "options"->>'mirrorApplyStatus' = 'APPLIED_PENDING_RECONCILE' THEN 'MIRROR_APPLIED'
    WHEN "options"->>'mirrorApplyStatus' IN ('MIRROR_TARGET_MISSING', 'UNRESOLVED') THEN 'MIRROR_FAILED'
    ELSE "mirrorStatus"
  END,
  "mirrorAppliedAt" = CASE
    WHEN "options"->>'mirrorApplyStatus' = 'APPLIED_PENDING_RECONCILE'
      THEN COALESCE(("options"->>'mirrorAppliedAt')::timestamp, "updatedAt")
    ELSE "mirrorAppliedAt"
  END
WHERE "options" ? 'mirrorApplyStatus';
