-- Must run outside a transaction. Confirm removals against pg_stat_user_indexes
-- and production EXPLAIN plans before applying this cleanup migration.
CREATE INDEX IF NOT EXISTS "RecurringEditScheduleState_due_active_idx"
  ON "RecurringEditScheduleState" ("shop","nextRunAt","recurringEditId")
  WHERE "disabledAt" IS NULL AND "nextRunAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ScheduledExportScheduleState_due_active_idx"
  ON "ScheduledExportScheduleState" ("shop","nextRunAt","scheduledExportId")
  WHERE "disabledAt" IS NULL AND "nextRunAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "RecurringEditRun_shop_recurringEditId_idx" ON "RecurringEditRun" ("shop","recurringEditId");
CREATE INDEX IF NOT EXISTS "RecurringEditRun_shop_editHistoryId_idx" ON "RecurringEditRun" ("shop","editHistoryId");
CREATE INDEX IF NOT EXISTS "ScheduledExportRun_shop_scheduledExportId_idx" ON "ScheduledExportRun" ("shop","scheduledExportId");
CREATE INDEX IF NOT EXISTS "ScheduledExportRun_shop_exportJobId_idx" ON "ScheduledExportRun" ("shop","exportJobId");

DROP INDEX IF EXISTS "RecurringEdit_shop_idx";
DROP INDEX IF EXISTS "RecurringEdit_shop_nextRunAt_idx";
DROP INDEX IF EXISTS "ScheduledExport_shop_idx";
DROP INDEX IF EXISTS "ScheduledExport_shop_nextRunAt_idx";
DROP INDEX IF EXISTS "RecurringEditRun_recurringEditId_idx";
DROP INDEX IF EXISTS "RecurringEditRun_editHistoryId_idx";
DROP INDEX IF EXISTS "ScheduledExportRun_scheduledExportId_idx";
DROP INDEX IF EXISTS "ScheduledExportRun_exportJobId_idx";
