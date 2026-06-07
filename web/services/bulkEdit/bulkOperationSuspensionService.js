import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";

async function resolveClient(client) {
  if (client) return client;
  const repository = await import("../../repositories/repositoryDb.js");
  return repository.db;
}

function resumeDate(error) {
  const parsed = error?.retryAfter instanceof Date
    ? error.retryAfter
    : new Date(error?.retryAfter || Date.now() + 5 * 60 * 1000);
  return Number.isFinite(parsed.getTime())
    ? parsed
    : new Date(Date.now() + 5 * 60 * 1000);
}

export async function suspendBulkEditForShopifyOutage({
  historyId,
  shop,
  error,
  client = null,
}) {
  const resolvedClient = await resolveClient(client);
  const history = await resolvedClient.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true },
  });
  const resumeAfter = resumeDate(error);
  const suspendedAt = new Date();
  return resolvedClient.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      executionState: {
        in: [
          OPERATION_LIFECYCLE_STATES.QUEUED,
          OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
          OPERATION_LIFECYCLE_STATES.EXECUTING,
          OPERATION_LIFECYCLE_STATES.SUSPENDED,
        ],
      },
    },
    data: {
      status: "pending",
      statusNormalized: normalizeEditHistoryStatus("pending"),
      executionState: OPERATION_LIFECYCLE_STATES.SUSPENDED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.SUSPENDED,
      ),
      batch: {
        ...(history?.batch && typeof history.batch === "object" ? history.batch : {}),
        suspension: {
          suspendedAt: suspendedAt.toISOString(),
          suspendReason: "SHOPIFY_UNAVAILABLE",
          resumeAfter: resumeAfter.toISOString(),
        },
      },
    },
  });
}

export async function suspendBulkUndoForShopifyOutage({
  historyId,
  shop,
  error,
  client = null,
}) {
  const resolvedClient = await resolveClient(client);
  const history = await resolvedClient.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { undo: true },
  });
  const undo = history?.undo && typeof history.undo === "object" ? history.undo : {};
  const resumeAfter = resumeDate(error);
  return resolvedClient.editHistory.updateMany({
    where: { id: historyId, shop },
    data: {
      status: "pending",
      statusNormalized: normalizeEditHistoryStatus("pending"),
      undo: {
        ...undo,
        status: "pending",
        state: "suspended",
        suspendedAt: new Date().toISOString(),
        suspendReason: "SHOPIFY_UNAVAILABLE",
        resumeAfter: resumeAfter.toISOString(),
      },
    },
  });
}

export function suspensionDelayMs(error, nowMs = Date.now()) {
  return Math.max(1_000, resumeDate(error).getTime() - nowMs);
}
