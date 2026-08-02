-- Complete source/reconciliation coverage for independently mutable mirror children.
ALTER TABLE "ProductMediaMirror"
  ADD COLUMN "sourceEntityUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "sourceEventOccurredAt" TIMESTAMP(3),
  ADD COLUMN "sourceVersion" TEXT,
  ADD COLUMN "lastChangeSource" TEXT,
  ADD COLUMN "reconciliationCompletedAt" TIMESTAMP(3),
  ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ProductCollection"
  ADD COLUMN "sourceEntityUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "sourceEventOccurredAt" TIMESTAMP(3),
  ADD COLUMN "sourceVersion" TEXT,
  ADD COLUMN "lastChangeSource" TEXT,
  ADD COLUMN "reconciliationCompletedAt" TIMESTAMP(3),
  ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- Undo revisions may refer only to a preview contract owned by the same tenant.
ALTER TABLE "UndoOperation" ADD CONSTRAINT "UndoOperation_shop_previewContractId_fkey"
  FOREIGN KEY ("shop", "previewContractId") REFERENCES "PreviewContract" ("shop", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "UndoOperation" VALIDATE CONSTRAINT "UndoOperation_shop_previewContractId_fkey";
CREATE INDEX "UndoOperation_shop_previewContractId_idx"
  ON "UndoOperation" ("shop", "previewContractId");

-- Terminal projections are merchant-owned whenever either endpoint belongs to a
-- merchant workflow. Resolve ownership from authoritative workflow tables.
ALTER TABLE "TerminalProjection" ADD COLUMN "shop" TEXT;
UPDATE "TerminalProjection" projection SET "shop" = COALESCE(
  (SELECT history."shop" FROM "EditHistory" history WHERE history."id" = projection."sourceId" LIMIT 1),
  (SELECT history."shop" FROM "EditHistory" history WHERE history."id" = projection."targetId" LIMIT 1),
  (SELECT job."shop" FROM "ExportJob" job WHERE job."id" = projection."sourceId" LIMIT 1),
  (SELECT job."shop" FROM "ExportJob" job WHERE job."id" = projection."targetId" LIMIT 1),
  (SELECT run."shop" FROM "RecurringEditRun" run WHERE run."id" = projection."sourceId" LIMIT 1),
  (SELECT run."shop" FROM "RecurringEditRun" run WHERE run."id" = projection."targetId" LIMIT 1),
  (SELECT run."shop" FROM "ScheduledExportRun" run WHERE run."id" = projection."sourceId" LIMIT 1),
  (SELECT run."shop" FROM "ScheduledExportRun" run WHERE run."id" = projection."targetId" LIMIT 1)
);

ALTER TABLE "RunFinalizationIntent" ADD COLUMN "shop" TEXT;
UPDATE "RunFinalizationIntent" intent SET "shop" = COALESCE(
  (SELECT run."shop" FROM "RecurringEditRun" run WHERE run."id" = intent."targetRunId" LIMIT 1),
  (SELECT run."shop" FROM "ScheduledExportRun" run WHERE run."id" = intent."targetRunId" LIMIT 1),
  (SELECT history."shop" FROM "EditHistory" history WHERE history."id" = intent."sourceId" LIMIT 1),
  (SELECT job."shop" FROM "ExportJob" job WHERE job."id" = intent."sourceId" LIMIT 1)
);

CREATE TABLE "UnresolvedTerminalOwnershipQuarantine" (
  "modelName" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "rowJson" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "quarantinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UnresolvedTerminalOwnershipQuarantine_pkey" PRIMARY KEY ("modelName", "recordId")
);
INSERT INTO "UnresolvedTerminalOwnershipQuarantine" ("modelName", "recordId", "rowJson", "reason")
SELECT 'TerminalProjection', "id", to_jsonb(projection), 'MERCHANT_OWNER_UNRESOLVED'
FROM "TerminalProjection" projection WHERE "shop" IS NULL;
INSERT INTO "UnresolvedTerminalOwnershipQuarantine" ("modelName", "recordId", "rowJson", "reason")
SELECT 'RunFinalizationIntent', "id", to_jsonb(intent), 'MERCHANT_OWNER_UNRESOLVED'
FROM "RunFinalizationIntent" intent WHERE "shop" IS NULL;
DELETE FROM "TerminalProjection" WHERE "shop" IS NULL;
DELETE FROM "RunFinalizationIntent" WHERE "shop" IS NULL;
ALTER TABLE "TerminalProjection" ALTER COLUMN "shop" SET NOT NULL;
ALTER TABLE "RunFinalizationIntent" ALTER COLUMN "shop" SET NOT NULL;

DROP INDEX "TerminalProjection_source_version_key";
CREATE UNIQUE INDEX "TerminalProjection_shop_source_version_key"
  ON "TerminalProjection" ("shop", "sourceType", "sourceId", "sourceVersion", "targetType");
DROP INDEX "RunFinalizationIntent_kind_sourceId_sourceVersion_targetRunId_key";
CREATE UNIQUE INDEX "RunFinalizationIntent_shop_kind_source_version_target_key"
  ON "RunFinalizationIntent" ("shop", "kind", "sourceId", "sourceVersion", "targetRunId");
CREATE INDEX "TerminalProjection_shop_target_idx"
  ON "TerminalProjection" ("shop", "targetType", "targetId");
CREATE INDEX "RunFinalizationIntent_shop_targetRunId_idx"
  ON "RunFinalizationIntent" ("shop", "targetRunId");

-- Split durable subscription commands out of expiring FilterTrack telemetry.
CREATE TABLE "SubscriptionCommand" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "planKey" TEXT NOT NULL,
  "returnUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION',
  "idempotencyKeyHash" TEXT,
  "confirmationUrl" TEXT,
  "subscriptionId" TEXT,
  "stateVersion" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SubscriptionCommand_state_version_ck" CHECK ("stateVersion" >= 0),
  CONSTRAINT "SubscriptionCommand_status_ck" CHECK (
    "status" IN ('PENDING_CONFIRMATION','COMPLETED','FAILED','CANCELLED')
  )
);
CREATE UNIQUE INDEX "SubscriptionCommand_shop_id_key" ON "SubscriptionCommand" ("shop", "id");
CREATE INDEX "SubscriptionCommand_shop_status_updatedAt_idx" ON "SubscriptionCommand" ("shop", "status", "updatedAt");

-- Defensive backfill for databases where legacy rows were inserted through raw
-- SQL before the FilterTrack enum restriction was enforced.
INSERT INTO "SubscriptionCommand" (
  "id", "shop", "planKey", "returnUrl", "status", "idempotencyKeyHash",
  "confirmationUrl", "subscriptionId", "createdAt", "updatedAt"
)
SELECT track."id", track."shop", COALESCE(track."field", track."value"->>'planKey'),
  track."value"->>'returnUrl', COALESCE(track."value"->>'status', 'PENDING_CONFIRMATION'),
  CASE WHEN track."searchKey" IS NULL THEN NULL ELSE
    md5(track."searchKey") || md5('subscription-command:' || track."searchKey") END,
  track."value"->>'confirmationUrl', track."value"->>'subscriptionId',
  track."createdAt", track."updatedAt"
FROM "FilterTrack" track
WHERE (track."source" = 'subscription_command' OR track."type"::text = 'subscription_command')
  AND COALESCE(track."field", track."value"->>'planKey') IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
