import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { enqueueAutomaticProductRuleExecutionJob } from "../../services/automaticProductRuleExecutionService.js";

const QUEUE_NAME = process.env.TARGET_FREEZE_QUEUE || "target-freeze";

const TARGET_FREEZE_COMMAND_STATUS = Object.freeze({
  PENDING: "PENDING",
  DISPATCHING: "DISPATCHING",
  DISPATCHED: "DISPATCHED",
});

function assertValidTargetFreezePayload(payload) {
  if (!payload?.shop || !payload?.operationId || !payload?.runId) {
    throw new Error("target freeze payload requires shop, operationId, and runId");
  }
}

async function loadRunAndCommand({ shop, runId, operationId }) {
  const run = await db.automaticProductRuleRun.findFirst({
    where: { id: runId, shop, operationId },
    include: { automaticProductRule: true },
  });

  if (!run) {
    throw new Error("TARGET_FREEZE_RUN_NOT_FOUND");
  }

  const command = await db.targetFreezeCommand.findFirst({
    where: {
      shop,
      operationId,
      status: TARGET_FREEZE_COMMAND_STATUS.PENDING,
    },
    orderBy: { createdAt: "asc" },
  });

  if (!command) {
    throw new Error("TARGET_FREEZE_COMMAND_NOT_FOUND");
  }

  return { run, command };
}

function assertCommandStillSafe({ run, rule, command }) {
  if (!rule) throw new Error("TARGET_FREEZE_RULE_NOT_FOUND");
  if (rule.deletedAt) throw new Error("TARGET_FREEZE_RULE_DELETED");
  if (!["ACTIVE", "PAUSED"].includes(String(rule.status || "").toUpperCase())) {
    throw new Error("TARGET_FREEZE_RULE_NOT_RUNNABLE");
  }

  if (command.sourceId !== rule.id) {
    throw new Error("TARGET_FREEZE_SOURCE_RULE_MISMATCH");
  }

  if (Number.isInteger(command.sourceRevision) && Number.isInteger(rule.revision)) {
    if (command.sourceRevision !== rule.revision) {
      throw new Error("TARGET_FREEZE_RULE_REVISION_STALE");
    }
  }

  if (command.mirrorBatchId && run.mirrorBatchId && command.mirrorBatchId !== run.mirrorBatchId) {
    throw new Error("TARGET_FREEZE_MIRROR_BATCH_MISMATCH");
  }

  if (command.status !== TARGET_FREEZE_COMMAND_STATUS.PENDING) {
    throw new Error("TARGET_FREEZE_COMMAND_NOT_PENDING");
  }
}

async function processTargetFreezeRequested(payload) {
  assertValidTargetFreezePayload(payload);
  const { shop, operationId, runId } = payload;

  const { run, command } = await loadRunAndCommand({ shop, runId, operationId });
  assertCommandStillSafe({
    run,
    rule: run.automaticProductRule,
    command,
  });

  const claimed = await db.targetFreezeCommand.updateMany({
    where: {
      id: command.id,
      status: TARGET_FREEZE_COMMAND_STATUS.PENDING,
    },
    data: {
      status: TARGET_FREEZE_COMMAND_STATUS.DISPATCHING,
      updatedAt: new Date(),
    },
  });

  if (claimed.count !== 1) {
    return { skipped: true, reason: "command_already_claimed" };
  }

  try {
    await enqueueAutomaticProductRuleExecutionJob({
      runId: run.id,
      shop: run.shop,
    });

    const movedDispatched = await db.targetFreezeCommand.updateMany({
      where: {
        id: command.id,
        status: TARGET_FREEZE_COMMAND_STATUS.DISPATCHING,
      },
      data: {
        status: TARGET_FREEZE_COMMAND_STATUS.DISPATCHED,
        updatedAt: new Date(),
      },
    });
    if (movedDispatched.count !== 1) {
      throw new Error("TARGET_FREEZE_DISPATCH_TRANSITION_REJECTED");
    }

    return { queued: true, runId: run.id, commandId: command.id };
  } catch (error) {
    await db.targetFreezeCommand.updateMany({
      where: {
        id: command.id,
        status: TARGET_FREEZE_COMMAND_STATUS.DISPATCHING,
      },
      data: {
        status: TARGET_FREEZE_COMMAND_STATUS.PENDING,
        updatedAt: new Date(),
      },
    });
    throw error;
  }
}

const targetFreezeQueueWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    if (job.name !== "TARGET_FREEZE_REQUESTED") {
      throw new Error(`Unsupported target freeze job: ${job.name}`);
    }
    return processTargetFreezeRequested(job.data || {});
  },
  { connection, concurrency: 5 },
);

targetFreezeQueueWorker.on("completed", (job, result) => {
  logger.info("Target freeze queue worker completed job", {
    worker: "targetFreezeQueueWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    name: job?.name,
    result,
  });
});

targetFreezeQueueWorker.on("failed", async (job, error) => {
  logger.error("Target freeze queue worker failed job", {
    worker: "targetFreezeQueueWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    name: job?.name,
    message: error?.message,
  });
  await logWorkerError({
    shop: job?.data?.shop || null,
    err: error,
    source: "targetFreezeQueueWorker",
  });
});

export default targetFreezeQueueWorker;

