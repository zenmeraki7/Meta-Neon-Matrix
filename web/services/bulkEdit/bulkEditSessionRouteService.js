import { createJob } from "../../../db/syncJobs.js";
import {
  columnApplyFanout,
  countRowsByStatus,
  stageChanges,
} from "../../db/bulkEditChanges.js";
import { commitSession, getScoped } from "../../db/bulkEditSessions.js";

async function assertDraftSession(sessionId, shopDomain) {
  const session = await getScoped(sessionId, shopDomain);
  if (!session) {
    const error = new Error("Session not found");
    error.code = "SESSION_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  if (String(session.status) !== "DRAFT") {
    const error = new Error("Session is not open");
    error.code = "SESSION_NOT_OPEN";
    error.statusCode = 409;
    throw error;
  }
}

export async function stageSessionChanges(command) {
  const { shopDomain, sessionId, changes } = command;
  await assertDraftSession(sessionId, shopDomain);
  await stageChanges(sessionId, shopDomain, changes);
  return { staged: changes.length };
}

export async function applyColumnChanges(command) {
  const { shopDomain, sessionId, namespace, key, value, variantIds } = command;
  await assertDraftSession(sessionId, shopDomain);
  const result = await columnApplyFanout(
    sessionId,
    shopDomain,
    namespace,
    key,
    value,
    variantIds,
  );
  return { staged: Number(result?.staged || 0) };
}

export async function commitBulkEditSession(command) {
  const { shopDomain, sessionId } = command;
  await assertDraftSession(sessionId, shopDomain);

  const pendingCount = await countRowsByStatus(sessionId, shopDomain, "PENDING");
  if (pendingCount === 0) {
    const error = new Error("No pending changes to commit");
    error.code = "NO_PENDING_CHANGES";
    error.statusCode = 422;
    throw error;
  }

  await commitSession(sessionId, shopDomain);
  const job = await createJob({
    shopDomain,
    type: "BULK_WRITE",
    meta: { sessionId },
  });

  return {
    jobId: job.id,
    sessionId,
    changeCount: pendingCount,
  };
}
