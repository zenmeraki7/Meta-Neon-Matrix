import { scheduleDueScheduledExportRuns } from "../../services/scheduledExportExecutionService.js";
import { purgeExpiredFilterTracks } from "../../services/filterTrackCleanupService.js";
import logger from "../../utils/loggerUtils.js";

const SCHEDULE_INTERVAL_MS = 10_000;
let lastFilterTrackPurgeAt = 0;
const FILTER_TRACK_PURGE_INTERVAL_MS = 5 * 60 * 1000;

async function runSchedulerTick() {
  try {
    // console.log("🔥 Scheduled export tick fired");
    const result = await scheduleDueScheduledExportRuns();
    // console.log("📊 Scheduler result:", result);
    // logger.info("Scheduled export scheduler tick", {
    //   scheduled: result?.scheduled ?? 0,
    //   skipped: result?.skipped ?? 0,
    //   scanned: result?.scanned ?? 0,
    //   reason: result?.reason ?? null, // ← this will show "scheduler_locked" if stuck
    //   timestamp: new Date().toISOString(),
    // });

    

  } catch (error) {
    logger.error("Scheduled export scheduler tick failed", {
      error: error.message,
      stack: error.stack,
    });
  }
}

if (!globalThis.__scheduledExportSchedulerStarted) {
  globalThis.__scheduledExportSchedulerStarted = true;
  setTimeout(runSchedulerTick, 5_000);
  setInterval(runSchedulerTick, SCHEDULE_INTERVAL_MS);
}
    const now = Date.now();
    if (now - lastFilterTrackPurgeAt >= FILTER_TRACK_PURGE_INTERVAL_MS) {
      lastFilterTrackPurgeAt = now;
      await purgeExpiredFilterTracks({ limit: 2000 });
    }
