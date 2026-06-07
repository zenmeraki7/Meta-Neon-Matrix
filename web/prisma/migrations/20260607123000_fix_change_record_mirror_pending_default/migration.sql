ALTER TABLE "ChangeRecord"
  ALTER COLUMN "mirrorStatus" SET DEFAULT 'MIRROR_PENDING';

UPDATE "ChangeRecord"
SET "mirrorStatus" = 'MIRROR_PENDING'
WHERE "mirrorStatus" = 'NOT_PENDING'
  AND "status" IN ('SUCCESS', 'VERIFIED', 'APPLIED')
  AND "mirrorAppliedAt" IS NULL;
