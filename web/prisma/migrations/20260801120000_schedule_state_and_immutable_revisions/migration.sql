CREATE TABLE "RecurringEditRevision" (
  "shop" TEXT NOT NULL, "recurringEditId" TEXT NOT NULL, "revision" INTEGER NOT NULL,
  "configurationHash" TEXT NOT NULL, "filterSnapshotHash" TEXT NOT NULL,
  "selectedFieldsSnapshotHash" TEXT NOT NULL, "rulesActionsSnapshotHash" TEXT NOT NULL,
  "schedulePolicySnapshotHash" TEXT NOT NULL, "definitionSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecurringEditRevision_pkey" PRIMARY KEY ("shop","recurringEditId","revision")
);
CREATE INDEX "RecurringEditRevision_shop_createdAt_idx" ON "RecurringEditRevision" ("shop","createdAt");

CREATE TABLE "ScheduledExportRevision" (
  "shop" TEXT NOT NULL, "scheduledExportId" TEXT NOT NULL, "revision" INTEGER NOT NULL,
  "configurationHash" TEXT NOT NULL, "filterSnapshotHash" TEXT NOT NULL,
  "selectedFieldsSnapshotHash" TEXT NOT NULL, "rulesActionsSnapshotHash" TEXT NOT NULL,
  "schedulePolicySnapshotHash" TEXT NOT NULL, "definitionSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduledExportRevision_pkey" PRIMARY KEY ("shop","scheduledExportId","revision")
);
CREATE INDEX "ScheduledExportRevision_shop_createdAt_idx" ON "ScheduledExportRevision" ("shop","createdAt");

-- Seed immutable current revisions without fabricating historical revisions.
WITH snapshots AS (
  SELECT definition.*, jsonb_build_object(
    'ownerType','RECURRING_EDIT', 'title',definition."title", 'status',definition."status",
    'filter',jsonb_build_object('filterAst',definition."filterAst",'normalizedFilterAst',definition."normalizedFilterAst",'normalizedFilterHash',definition."filterHash",'rawFilterInput',definition."filterParams",'targetGranularity',definition."targetGranularity",'targetingSnapshotMeta',definition."targetingSnapshotMeta"),
    'selectedFields','[]'::jsonb, 'rulesActions',jsonb_build_object('rules',definition."rules"),
    'schedulePolicy',jsonb_build_object('scheduleType',definition."scheduleType",'timezone',definition."timezone",'scheduleConfig',definition."scheduleConfig",'cronExpression',definition."cronExpression",'intervalMinutes',definition."intervalMinutes",'startAt',definition."startAt",'endAt',definition."endAt",'missedRunPolicy','SKIP'),
    'generatedFilename',NULL, 'targetFreezeMode',definition."targetingMode",
    'targetingCompilerVersion',definition."targetingCompilerVersion",'fieldRegistryVersion',definition."fieldRegistryVersion",'operatorRegistryVersion',definition."operatorRegistryVersion"
  ) AS snapshot
  FROM "RecurringEdit" definition
)
INSERT INTO "RecurringEditRevision"
SELECT "shop","id","revision",
  encode(digest(snapshot::text,'sha256'),'hex'),
  encode(digest((snapshot->'filter')::text,'sha256'),'hex'),
  encode(digest((snapshot->'selectedFields')::text,'sha256'),'hex'),
  encode(digest((snapshot->'rulesActions')::text,'sha256'),'hex'),
  encode(digest((snapshot->'schedulePolicy')::text,'sha256'),'hex'), snapshot, CURRENT_TIMESTAMP
FROM snapshots;

WITH snapshots AS (
  SELECT definition.*, jsonb_build_object(
    'ownerType','SCHEDULED_EXPORT', 'title',definition."title", 'status',definition."status",
    'filter',jsonb_build_object('filterAst',definition."filterAst",'normalizedFilterAst',definition."normalizedFilterAst",'normalizedFilterHash',definition."filterHash",'rawFilterInput',definition."filterParams",'targetGranularity',definition."targetGranularity",'targetingSnapshotMeta',definition."targetingSnapshotMeta"),
    'selectedFields',to_jsonb(definition."fields"), 'rulesActions',jsonb_build_object('selectedFieldKeys',to_jsonb(definition."fields")),
    'schedulePolicy',jsonb_build_object('scheduleType',definition."scheduleType",'timezone',definition."timezone",'scheduleConfig',definition."scheduleConfig",'cronExpression',definition."cronExpression",'intervalMinutes',definition."intervalMinutes",'startAt',definition."startAt",'endAt',definition."endAt",'missedRunPolicy','SKIP'),
    'generatedFilename',definition."filename", 'targetFreezeMode',definition."targetingMode",
    'targetingCompilerVersion',definition."targetingCompilerVersion",'fieldRegistryVersion',definition."fieldRegistryVersion",'operatorRegistryVersion',definition."operatorRegistryVersion"
  ) AS snapshot
  FROM "ScheduledExport" definition
)
INSERT INTO "ScheduledExportRevision"
SELECT "shop","id","revision",
  encode(digest(snapshot::text,'sha256'),'hex'),
  encode(digest((snapshot->'filter')::text,'sha256'),'hex'),
  encode(digest((snapshot->'selectedFields')::text,'sha256'),'hex'),
  encode(digest((snapshot->'rulesActions')::text,'sha256'),'hex'),
  encode(digest((snapshot->'schedulePolicy')::text,'sha256'),'hex'), snapshot, CURRENT_TIMESTAMP
FROM snapshots;

CREATE TABLE "RecurringEditScheduleState" (
  "shop" TEXT NOT NULL, "recurringEditId" TEXT NOT NULL, "definitionRevision" INTEGER NOT NULL,
  "scheduleVersion" INTEGER NOT NULL DEFAULT 1, "nextRunAt" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3), "claimOwner" TEXT, "claimExpiresAt" TIMESTAMP(3),
  "fencingToken" BIGINT NOT NULL DEFAULT 0, "missedRunPolicy" TEXT NOT NULL DEFAULT 'SKIP',
  "disabledAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringEditScheduleState_pkey" PRIMARY KEY ("shop","recurringEditId"),
  CONSTRAINT "RecurringEditScheduleState_version_check" CHECK ("definitionRevision">0 AND "scheduleVersion">0 AND "fencingToken">=0),
  CONSTRAINT "RecurringEditScheduleState_policy_check" CHECK ("missedRunPolicy" IN ('SKIP','CATCH_UP_ONE','CATCH_UP_ALL'))
);
CREATE INDEX "RecurringEditScheduleState_shop_claimExpiresAt_idx" ON "RecurringEditScheduleState" ("shop","claimExpiresAt","recurringEditId");

CREATE TABLE "ScheduledExportScheduleState" (
  "shop" TEXT NOT NULL, "scheduledExportId" TEXT NOT NULL, "definitionRevision" INTEGER NOT NULL,
  "scheduleVersion" INTEGER NOT NULL DEFAULT 1, "nextRunAt" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3), "claimOwner" TEXT, "claimExpiresAt" TIMESTAMP(3),
  "fencingToken" BIGINT NOT NULL DEFAULT 0, "missedRunPolicy" TEXT NOT NULL DEFAULT 'SKIP',
  "disabledAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduledExportScheduleState_pkey" PRIMARY KEY ("shop","scheduledExportId"),
  CONSTRAINT "ScheduledExportScheduleState_version_check" CHECK ("definitionRevision">0 AND "scheduleVersion">0 AND "fencingToken">=0),
  CONSTRAINT "ScheduledExportScheduleState_policy_check" CHECK ("missedRunPolicy" IN ('SKIP','CATCH_UP_ONE','CATCH_UP_ALL'))
);
CREATE INDEX "ScheduledExportScheduleState_shop_claimExpiresAt_idx" ON "ScheduledExportScheduleState" ("shop","claimExpiresAt","scheduledExportId");

INSERT INTO "RecurringEditScheduleState" ("shop","recurringEditId","definitionRevision","nextRunAt","disabledAt","updatedAt")
SELECT "shop","id","revision","nextRunAt",CASE WHEN "status"::text='ACTIVE' AND NOT "isDeleted" THEN NULL ELSE CURRENT_TIMESTAMP END,CURRENT_TIMESTAMP FROM "RecurringEdit";
INSERT INTO "ScheduledExportScheduleState" ("shop","scheduledExportId","definitionRevision","nextRunAt","disabledAt","updatedAt")
SELECT "shop","id","revision","nextRunAt",CASE WHEN "status"::text='ACTIVE' AND NOT "isDeleted" THEN NULL ELSE CURRENT_TIMESTAMP END,CURRENT_TIMESTAMP FROM "ScheduledExport";

ALTER TABLE "RecurringEditRun" ADD COLUMN "definitionRevision" INTEGER, ADD COLUMN "configurationHash" TEXT,
  ADD COLUMN "filterSnapshotHash" TEXT, ADD COLUMN "selectedFieldsSnapshotHash" TEXT,
  ADD COLUMN "rulesActionsSnapshotHash" TEXT, ADD COLUMN "schedulePolicySnapshotHash" TEXT,
  ADD COLUMN "legacyRevisionUnknown" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ScheduledExportRun" ADD COLUMN "definitionRevision" INTEGER, ADD COLUMN "configurationHash" TEXT,
  ADD COLUMN "filterSnapshotHash" TEXT, ADD COLUMN "selectedFieldsSnapshotHash" TEXT,
  ADD COLUMN "rulesActionsSnapshotHash" TEXT, ADD COLUMN "schedulePolicySnapshotHash" TEXT,
  ADD COLUMN "legacyRevisionUnknown" BOOLEAN NOT NULL DEFAULT false;

UPDATE "RecurringEditRun" run SET
  "definitionRevision"=definition."revision", "configurationHash"=revision."configurationHash",
  "filterSnapshotHash"=revision."filterSnapshotHash", "selectedFieldsSnapshotHash"=revision."selectedFieldsSnapshotHash",
  "rulesActionsSnapshotHash"=revision."rulesActionsSnapshotHash", "schedulePolicySnapshotHash"=revision."schedulePolicySnapshotHash"
FROM "RecurringEdit" definition JOIN "RecurringEditRevision" revision
  ON revision."shop"=definition."shop" AND revision."recurringEditId"=definition."id" AND revision."revision"=definition."revision"
WHERE run."shop"=definition."shop" AND run."recurringEditId"=definition."id" AND run."createdAt">=definition."updatedAt";
UPDATE "RecurringEditRun" SET "legacyRevisionUnknown"=true WHERE "definitionRevision" IS NULL;

UPDATE "ScheduledExportRun" run SET
  "definitionRevision"=definition."revision", "configurationHash"=revision."configurationHash",
  "filterSnapshotHash"=revision."filterSnapshotHash", "selectedFieldsSnapshotHash"=revision."selectedFieldsSnapshotHash",
  "rulesActionsSnapshotHash"=revision."rulesActionsSnapshotHash", "schedulePolicySnapshotHash"=revision."schedulePolicySnapshotHash"
FROM "ScheduledExport" definition JOIN "ScheduledExportRevision" revision
  ON revision."shop"=definition."shop" AND revision."scheduledExportId"=definition."id" AND revision."revision"=definition."revision"
WHERE run."shop"=definition."shop" AND run."scheduledExportId"=definition."id" AND run."createdAt">=definition."updatedAt";
UPDATE "ScheduledExportRun" SET "legacyRevisionUnknown"=true WHERE "definitionRevision" IS NULL;

ALTER TABLE "RecurringEditRun" ADD CONSTRAINT "RecurringEditRun_revision_authority_check" CHECK (
  "legacyRevisionUnknown" OR ("definitionRevision" IS NOT NULL AND "configurationHash" IS NOT NULL AND "filterSnapshotHash" IS NOT NULL AND "selectedFieldsSnapshotHash" IS NOT NULL AND "rulesActionsSnapshotHash" IS NOT NULL AND "schedulePolicySnapshotHash" IS NOT NULL)
) NOT VALID;
ALTER TABLE "ScheduledExportRun" ADD CONSTRAINT "ScheduledExportRun_revision_authority_check" CHECK (
  "legacyRevisionUnknown" OR ("definitionRevision" IS NOT NULL AND "configurationHash" IS NOT NULL AND "filterSnapshotHash" IS NOT NULL AND "selectedFieldsSnapshotHash" IS NOT NULL AND "rulesActionsSnapshotHash" IS NOT NULL AND "schedulePolicySnapshotHash" IS NOT NULL)
) NOT VALID;
ALTER TABLE "RecurringEditRun" VALIDATE CONSTRAINT "RecurringEditRun_revision_authority_check";
ALTER TABLE "ScheduledExportRun" VALIDATE CONSTRAINT "ScheduledExportRun_revision_authority_check";

ALTER TABLE "RecurringEditRevision" ADD CONSTRAINT "RecurringEditRevision_owner_fkey" FOREIGN KEY ("shop","recurringEditId") REFERENCES "RecurringEdit"("shop","id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "ScheduledExportRevision" ADD CONSTRAINT "ScheduledExportRevision_owner_fkey" FOREIGN KEY ("shop","scheduledExportId") REFERENCES "ScheduledExport"("shop","id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "RecurringEditScheduleState" ADD CONSTRAINT "RecurringEditScheduleState_revision_fkey" FOREIGN KEY ("shop","recurringEditId","definitionRevision") REFERENCES "RecurringEditRevision"("shop","recurringEditId","revision") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "ScheduledExportScheduleState" ADD CONSTRAINT "ScheduledExportScheduleState_revision_fkey" FOREIGN KEY ("shop","scheduledExportId","definitionRevision") REFERENCES "ScheduledExportRevision"("shop","scheduledExportId","revision") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "RecurringEditRun" ADD CONSTRAINT "RecurringEditRun_revision_fkey" FOREIGN KEY ("shop","recurringEditId","definitionRevision") REFERENCES "RecurringEditRevision"("shop","recurringEditId","revision") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "ScheduledExportRun" ADD CONSTRAINT "ScheduledExportRun_revision_fkey" FOREIGN KEY ("shop","scheduledExportId","definitionRevision") REFERENCES "ScheduledExportRevision"("shop","scheduledExportId","revision") ON DELETE RESTRICT NOT VALID;

ALTER TABLE "RecurringEditRevision" VALIDATE CONSTRAINT "RecurringEditRevision_owner_fkey";
ALTER TABLE "ScheduledExportRevision" VALIDATE CONSTRAINT "ScheduledExportRevision_owner_fkey";
ALTER TABLE "RecurringEditScheduleState" VALIDATE CONSTRAINT "RecurringEditScheduleState_revision_fkey";
ALTER TABLE "ScheduledExportScheduleState" VALIDATE CONSTRAINT "ScheduledExportScheduleState_revision_fkey";
ALTER TABLE "RecurringEditRun" VALIDATE CONSTRAINT "RecurringEditRun_revision_fkey";
ALTER TABLE "ScheduledExportRun" VALIDATE CONSTRAINT "ScheduledExportRun_revision_fkey";
