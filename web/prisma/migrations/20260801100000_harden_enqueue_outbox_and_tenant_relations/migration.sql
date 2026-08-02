ALTER TABLE "OperationEnqueueIntent"
  ADD COLUMN "dispatchScope" VARCHAR(120) NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "fencingToken" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "OperationEnqueueIntent" ALTER COLUMN "dedupeKey" TYPE VARCHAR(512);
UPDATE "OperationEnqueueIntent" SET "nextAttemptAt" = "runAt" WHERE "nextAttemptAt" IS NULL;
ALTER TABLE "OperationEnqueueIntent" ALTER COLUMN "nextAttemptAt" SET NOT NULL;
UPDATE "OperationEnqueueIntent"
SET "status" = 'PENDING'::"OperationEnqueueIntentStatus",
    "dispatchOwner" = NULL, "claimToken" = NULL,
    "dispatchStartedAt" = NULL, "dispatchHeartbeatAt" = NULL
WHERE "status" = 'DISPATCHING'::"OperationEnqueueIntentStatus"
  AND COALESCE("dispatchHeartbeatAt", "dispatchStartedAt", "updatedAt") < NOW() - INTERVAL '5 minutes';

CREATE TABLE "OperationEnqueueIntentDuplicate" AS
SELECT * FROM (
  SELECT intent.*, row_number() OVER (
    PARTITION BY "shop", "dispatchScope", "dedupeKey"
    ORDER BY "createdAt", "id"
  ) AS duplicate_rank
  FROM "OperationEnqueueIntent" intent WHERE "dedupeKey" IS NOT NULL
) ranked WHERE duplicate_rank > 1;
UPDATE "OperationEnqueueIntent" authoritative
SET "status" = 'DISPATCHED'::"OperationEnqueueIntentStatus",
    "dispatchedAt" = COALESCE(authoritative."dispatchedAt", duplicate_outcome."dispatchedAt"),
    "lastError" = NULL
FROM (
  SELECT duplicate."shop", duplicate."dispatchScope", duplicate."dedupeKey", max(duplicate."dispatchedAt") AS "dispatchedAt"
  FROM "OperationEnqueueIntentDuplicate" duplicate
  WHERE duplicate."status" = 'DISPATCHED'::"OperationEnqueueIntentStatus"
  GROUP BY duplicate."shop", duplicate."dispatchScope", duplicate."dedupeKey"
) duplicate_outcome
WHERE authoritative."shop" = duplicate_outcome."shop"
  AND authoritative."dispatchScope" = duplicate_outcome."dispatchScope"
  AND authoritative."dedupeKey" = duplicate_outcome."dedupeKey"
  AND NOT EXISTS (SELECT 1 FROM "OperationEnqueueIntentDuplicate" d WHERE d."id" = authoritative."id");
DELETE FROM "OperationEnqueueIntent" intent
USING "OperationEnqueueIntentDuplicate" duplicate
WHERE intent."id" = duplicate."id";
DROP INDEX IF EXISTS "OperationEnqueueIntent_scheduled_run_uq";

ALTER TABLE "OutboxEvent"
  ADD COLUMN "payloadHash" TEXT,
  ADD COLUMN "lockToken" TEXT,
  ADD COLUMN "lockExpiresAt" TIMESTAMP(3),
  ADD COLUMN "fencingToken" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);
ALTER TABLE "OutboxEvent" ALTER COLUMN "eventIdentity" TYPE VARCHAR(512);
UPDATE "OutboxEvent"
SET "eventIdentity" = 'legacy:' || "id" WHERE "eventIdentity" IS NULL;
UPDATE "OutboxEvent"
SET "payloadHash" = md5(COALESCE("payloadJson"::text, 'null')) || md5('outbox:' || COALESCE("payloadJson"::text, 'null'))
WHERE "payloadHash" IS NULL;
UPDATE "OutboxEvent" SET "deadLetteredAt" = COALESCE("lastErrorAt", "updatedAt")
WHERE "statusNormalized" = 'DEAD_LETTER'::"OutboxEventStatus" AND "deadLetteredAt" IS NULL;
ALTER TABLE "OutboxEvent" ALTER COLUMN "eventIdentity" SET NOT NULL;
ALTER TABLE "OutboxEvent" ALTER COLUMN "payloadHash" SET NOT NULL;
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_terminal_timestamp_check" CHECK (
  ("statusNormalized" = 'DISPATCHED'::"OutboxEventStatus") = ("dispatchedAt" IS NOT NULL)
  AND ("statusNormalized" = 'DEAD_LETTER'::"OutboxEventStatus") = ("deadLetteredAt" IS NOT NULL)
) NOT VALID;

CREATE TABLE "TenantRelationQuarantine" (
  "relationName" TEXT NOT NULL, "childShop" TEXT NOT NULL,
  "childId" TEXT NOT NULL, "parentId" TEXT NOT NULL,
  "reason" TEXT NOT NULL, "quarantinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("relationName", "childShop", "childId")
);
INSERT INTO "TenantRelationQuarantine" ("relationName", "childShop", "childId", "parentId", "reason")
SELECT 'EditHistory.snapshotSetId', history."shop", history."id", history."snapshotSetId", 'CROSS_SHOP_OR_MISSING_PARENT'
FROM "EditHistory" history
WHERE history."snapshotSetId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "TargetSnapshotSet" snapshot
  WHERE snapshot."shop" = history."shop" AND snapshot."id" = history."snapshotSetId"
);
UPDATE "EditHistory" history SET "snapshotSetId" = NULL
FROM "TenantRelationQuarantine" quarantine
WHERE quarantine."relationName" = 'EditHistory.snapshotSetId'
  AND quarantine."childShop" = history."shop" AND quarantine."childId" = history."id";
DROP INDEX IF EXISTS "EditHistory_automaticProductRuleRunId_key";
DROP INDEX IF EXISTS "UndoCommand_undoOperationId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "UndoCommand_shop_undoOperationId_key" ON "UndoCommand"("shop", "undoOperationId");
ALTER TABLE "EditHistory" DROP CONSTRAINT IF EXISTS "EditHistory_snapshotSetId_fkey";
ALTER TABLE "EditHistory" ADD CONSTRAINT "EditHistory_shop_snapshotSetId_fkey"
  FOREIGN KEY ("shop", "snapshotSetId") REFERENCES "TargetSnapshotSet"("shop", "id")
  ON DELETE SET NULL NOT VALID;
ALTER TABLE "EditHistory" VALIDATE CONSTRAINT "EditHistory_shop_snapshotSetId_fkey";
