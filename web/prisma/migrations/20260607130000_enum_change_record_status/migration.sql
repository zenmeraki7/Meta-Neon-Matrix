ALTER TYPE "ChangeStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TYPE "ChangeStatus" ADD VALUE IF NOT EXISTS 'SUCCESS';
ALTER TYPE "ChangeStatus" ADD VALUE IF NOT EXISTS 'VERIFIED';
ALTER TYPE "ChangeStatus" ADD VALUE IF NOT EXISTS 'APPLIED';
ALTER TYPE "ChangeStatus" ADD VALUE IF NOT EXISTS 'ROLLED_BACK';
ALTER TYPE "ChangeStatus" ADD VALUE IF NOT EXISTS 'VERIFICATION_FAILED';

UPDATE "ChangeRecord"
SET "status" = CASE
  WHEN LOWER("status") = 'pending' THEN 'PENDING'
  WHEN LOWER("status") = 'failed' THEN 'FAILED'
  WHEN LOWER("status") = 'success' THEN 'SUCCESS'
  WHEN LOWER("status") = 'verified' THEN 'VERIFIED'
  WHEN LOWER("status") = 'applied' THEN 'APPLIED'
  WHEN LOWER("status") = 'rolled_back' THEN 'ROLLED_BACK'
  WHEN LOWER("status") = 'verification_failed' THEN 'VERIFICATION_FAILED'
  WHEN LOWER("status") = 'writing' THEN 'WRITING'
  WHEN LOWER("status") = 'written' THEN 'WRITTEN'
  WHEN LOWER("status") = 'error' THEN 'ERROR'
  ELSE "status"
END
WHERE "status" IS NOT NULL;

ALTER TABLE "ChangeRecord"
  ALTER COLUMN "status" SET DEFAULT 'PENDING',
  ALTER COLUMN "status" TYPE "ChangeStatus"
    USING "status"::"ChangeStatus";
