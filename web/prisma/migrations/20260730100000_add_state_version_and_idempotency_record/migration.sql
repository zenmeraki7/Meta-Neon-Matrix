-- Add stateVersion column to EditHistory and ExportJob
ALTER TABLE "EditHistory" ADD COLUMN IF NOT EXISTS "stateVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExportJob"   ADD COLUMN IF NOT EXISTS "stateVersion" INTEGER NOT NULL DEFAULT 0;

-- Create IdempotencyRecord table
CREATE TABLE IF NOT EXISTS "IdempotencyRecord" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "ownerToken" TEXT,
  "lockedUntil" TIMESTAMP(3),
  "responseJson" JSONB,
  "resourceType" TEXT,
  "resourceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyRecord_shop_scope_key_key" ON "IdempotencyRecord"("shop", "scope", "key");
CREATE INDEX IF NOT EXISTS "IdempotencyRecord_state_lockedUntil_idx" ON "IdempotencyRecord"("state", "lockedUntil");
