-- ExportJob is the authoritative execution and user-history model for manual
-- and scheduled exports. ScheduledExportRun remains the schedule-run record.
DROP TABLE IF EXISTS "ExportHistory";
