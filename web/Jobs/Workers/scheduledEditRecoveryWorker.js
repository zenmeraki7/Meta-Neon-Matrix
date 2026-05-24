import { scheduledEditQueue } from "../Queues/scheduledEditQueue.js";
import { prisma } from "../../config/database.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { joinSafeJobId } from "../../utils/jobQueueUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";

const POLL_INTERVAL_MS = 60_000;
const LIMIT = 100;

async function requeuePendingScheduledEdits() {
  const now = new Date();
  const rows = await prisma.editHistory.findMany({
    where: {
      type: "Scheduled edit",
      scheduledAt: { gt: now },
      statusNormalized: normalizeEditHistoryStatus("pending"),
      executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_PENDING_QUEUE,
    },
    select: {
      id: true,
      shop: true,
      scheduledAt: true,
    },
    orderBy: { scheduledAt: "asc" },
    take: LIMIT,
  });

  let recovered = 0;
  for (const row of rows) {
    const delay = Math.max(new Date(row.scheduledAt).getTime() - Date.now(), 0);
    await scheduledEditQueue.add(
      "scheduled-task",
      { historyId: row.id, shop: row.shop },
      {
        delay,
        jobId: joinSafeJobId("scheduled-edit", row.shop, row.id),
      },
    );
    await prisma.editHistory.update({
      where: { id: row.id },
      data: {
        executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
        ),
      },
    });
    recovered += 1;
  }

  if (recovered > 0) {
    logger.info("Recovered scheduled edits pending queue", {
      worker: "scheduledEditRecoveryWorker",
      recovered,
    });
  }
}

async function runRecoveryTick() {
  try {
    await requeuePendingScheduledEdits();
  } catch (error) {
    await logWorkerError({
      shop: "unknown",
      err: error,
      source: "scheduledEditRecoveryWorker",
    });
  }
}

if (!globalThis.__scheduledEditRecoveryWorkerStarted) {
  globalThis.__scheduledEditRecoveryWorkerStarted = true;
  setInterval(runRecoveryTick, POLL_INTERVAL_MS);
  runRecoveryTick().catch(() => {});
}
