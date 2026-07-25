DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationFingerprintStatus') THEN
    CREATE TYPE "OperationFingerprintStatus" AS ENUM (
      'RESERVED',
      'QUEUED',
      'STARTING_BULK_QUERY',
      'SUBMITTING',
      'RUNNING',
      'RETRYABLE_FAILURE',
      'FAILED',
      'ENQUEUE_FAILED',
      'RECONCILE_SUBMITTED',
      'INGESTING',
      'COMPLETED',
      'CANCELLED',
      'CANCEL_REQUESTED'
    );
  END IF;
END $$;

ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'RESERVED';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'QUEUED';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'STARTING_BULK_QUERY';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'SUBMITTING';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'RUNNING';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'RETRYABLE_FAILURE';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'ENQUEUE_FAILED';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'RECONCILE_SUBMITTED';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'INGESTING';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "OperationFingerprintStatus" ADD VALUE IF NOT EXISTS 'CANCEL_REQUESTED';

ALTER TABLE "OperationFingerprint"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "OperationFingerprintStatus"
  USING ("status"::text::"OperationFingerprintStatus"),
  ALTER COLUMN "status" SET DEFAULT 'RESERVED'::"OperationFingerprintStatus";
