import { prisma } from "../../config/database.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import {
  dispatchPendingEnqueueIntents,
  ENQUEUE_QUEUE_KEYS,
} from "../../services/operationEnqueueIntentService.js";

const POLL_INTERVAL_MS = 60_000;
const LIMIT = 100;

async function runIntentDispatch(queueKey) {
  const shops = await prisma.operationEnqueueIntent.findMany({
    where: {
      status: "PENDING",
      queueKey,
      runAt: { lte: new Date() },
    },
    select: { shop: true },
    distinct: ["shop"],
    take: LIMIT,
  });

  let dispatched = 0;
  for (const row of shops) {
    // eslint-disable-next-line no-await-in-loop
    const result = await dispatchPendingEnqueueIntents({
      shop: row.shop,
      queueKey,
      limit: LIMIT,
    });
    dispatched += Number(result.dispatched || 0);
  }

  return dispatched;
}

async function runTick() {
  try {
    const [scheduledDispatched, pipelineDispatched] = await Promise.all([
      runIntentDispatch(ENQUEUE_QUEUE_KEYS.SCHEDULED_EDIT),
      runIntentDispatch(ENQUEUE_QUEUE_KEYS.BULK_EDIT_PIPELINE),
    ]);

    if (scheduledDispatched > 0 || pipelineDispatched > 0) {
      logger.info("Operation enqueue intent recovery dispatched pending intents", {
        worker: "operationEnqueueIntentRecoveryWorker",
        scheduledDispatched,
        pipelineDispatched,
      });
    }
  } catch (error) {
    await logWorkerError({
      shop: "unknown",
      err: error,
      source: "operationEnqueueIntentRecoveryWorker",
    });
  }
}

if (!globalThis.__operationEnqueueIntentRecoveryWorkerStarted) {
  globalThis.__operationEnqueueIntentRecoveryWorkerStarted = true;
  setInterval(runTick, POLL_INTERVAL_MS);
  runTick().catch(() => {});
}
