import sql from "../db/client.js";
import { startJob } from "../db/syncJobs.js";
import { runFullSync } from "./fullSync.js";
import { runIncrementalSync } from "./incrementalSync.js";

let runnerStarted = false;

async function runLoopTick() {
  const rows = await sql`
    SELECT *
    FROM sync_jobs
    WHERE status = 'PENDING'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  const job = rows[0] || null;
  if (!job) return;

  const type = String(job.type || "").toUpperCase();
  if (type === "FULL_SYNC") {
    await runFullSync(job);
    return;
  }
  if (type === "INCREMENTAL_SYNC") {
    await runIncrementalSync(job);
    return;
  }
  if (type === "BULK_WRITE") {
    console.log("[jobRunner] BULK_WRITE handled by Layer 3", { jobId: job.id, shop: job.shop_id });
    await startJob(job.id);
    return;
  }

  console.warn("[jobRunner] unsupported sync_jobs type", { jobId: job.id, type });
}

/**
 * Starts single-worker polling job runner.
 * @returns {void}
 */
export function startJobRunner() {
  if (runnerStarted) return;
  runnerStarted = true;

  const execute = async () => {
    try {
      await runLoopTick();
    } catch (error) {
      console.error("[jobRunner] tick error", error?.message || error);
    }
  };

  void execute();
  setInterval(() => {
    void execute();
  }, 5000);
}
