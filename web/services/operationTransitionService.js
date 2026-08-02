import {
  canTransitionOperationState,
  OPERATION_LIFECYCLE_STATES,
} from "./operationLifecycleStateMachine.js";
import { guardedEditHistoryUpdate } from "./operationTransitionGuards.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../utils/normalizedStateUtils.js";

const TERMINAL_STATES = new Set([
  OPERATION_LIFECYCLE_STATES.COMPLETED,
  OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
  OPERATION_LIFECYCLE_STATES.FAILED,
  OPERATION_LIFECYCLE_STATES.CANCELLED,
  OPERATION_LIFECYCLE_STATES.UNDO_COMPLETED,
]);

const RECOVERY_ALLOWED_TERMINAL_OVERRIDES = new Set([
  OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
  OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
  OPERATION_LIFECYCLE_STATES.VERIFYING,
  OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
]);

async function getDefaultDb() {
  const { db } = await import("../repositories/repositoryDb.js");
  return db;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function inferTerminalizedAt(nextState) {
  return TERMINAL_STATES.has(String(nextState || "").toUpperCase()) ? new Date() : null;
}

function deriveStatusFromExecutionState(nextState, fallbackStatus) {
  const next = String(nextState || "").toUpperCase();
  if (next === OPERATION_LIFECYCLE_STATES.COMPLETED) return "completed";
  if (next === OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED) return "partial";
  if (next === OPERATION_LIFECYCLE_STATES.FAILED) return "failed";
  if (next === OPERATION_LIFECYCLE_STATES.CANCELLED) return "cancelled";
  return fallbackStatus || null;
}

function appendTransitionAudit(batch, entry) {
  const current = asObject(batch);
  const existing = Array.isArray(current.operationTransitionAudit)
    ? current.operationTransitionAudit
    : [];
  const next = [...existing, entry];
  return {
    ...current,
    operationTransitionAudit: next.slice(-100),
  };
}

function isSameTransition(existingEntry, transitionKey, nextExecutionState) {
  if (!existingEntry) return false;
  return String(existingEntry.transitionKey || "") === String(transitionKey || "")
    && String(existingEntry.nextExecutionState || "") === String(nextExecutionState || "");
}

export async function transitionOperation({
  shop,
  operationId,
  expectedExecutionStates = [],
  expectedStatuses = [],
  nextExecutionState,
  expectedFenceToken = null,
  transitionKey,
  actor = null,
  reasonCode = null,
  metadata = null,
  allowTerminalOverride = false,
  dataPatch = null,
  db = null,
}) {
  if (!shop || !operationId) throw new Error("TRANSITION_SCOPE_REQUIRED");
  if (!nextExecutionState) throw new Error("TRANSITION_NEXT_STATE_REQUIRED");
  if (!transitionKey) throw new Error("TRANSITION_KEY_REQUIRED");

  const client = db || await getDefaultDb();
  const row = await client.editHistory.findFirst({
    where: { id: operationId, shop },
    select: {
      id: true,
      shop: true,
      statusNormalized: true,
      executionStateNormalized: true,
      executionIdentity: true,
      completedAt: true,
      batch: true,
    },
  });
  if (!row) return { ok: false, reason: "NOT_FOUND" };

  const currentState = String(row.executionStateNormalized || "UNKNOWN").toUpperCase();
  const nextState = String(nextExecutionState || "").toUpperCase();
  const batch = asObject(row.batch);
  const fenceToken = Number(batch.executeLeaseFencingToken || 0);

  if (
    expectedFenceToken !== null
    && Number(expectedFenceToken) !== Number(fenceToken)
  ) {
    return { ok: false, reason: "STALE_FENCE_TOKEN", currentState, fenceToken };
  }

  const lastAudit = Array.isArray(batch.operationTransitionAudit)
    ? batch.operationTransitionAudit[batch.operationTransitionAudit.length - 1]
    : null;
  if (isSameTransition(lastAudit, transitionKey, nextState)) {
    return { ok: true, idempotent: true, currentState, nextState };
  }

  const inTerminal = TERMINAL_STATES.has(currentState);
  if (inTerminal) {
    const recoveryAllowed = allowTerminalOverride
      && RECOVERY_ALLOWED_TERMINAL_OVERRIDES.has(nextState);
    if (!recoveryAllowed) {
      return { ok: false, reason: "TERMINAL_STATE_MUTATION_REJECTED", currentState };
    }
  }

  if (!inTerminal && currentState !== nextState && !canTransitionOperationState(currentState, nextState)) {
    return {
      ok: false,
      reason: "INVALID_STATE_TRANSITION",
      currentState,
      nextState,
    };
  }

  const derivedStatus = deriveStatusFromExecutionState(nextState, row.statusNormalized);
  const nowIso = new Date().toISOString();
  const updatedBatch = appendTransitionAudit(batch, {
    at: nowIso,
    transitionKey,
    fromExecutionState: currentState,
    nextExecutionState: nextState,
    reasonCode: reasonCode || null,
    actor: actor || null,
    metadata: metadata || null,
    expectedFenceToken: expectedFenceToken === null ? null : Number(expectedFenceToken),
  });

  const patchObject = dataPatch && typeof dataPatch === "object" ? dataPatch : {};
  const mergedBatchPatch = Object.prototype.hasOwnProperty.call(patchObject, "batch")
    ? appendTransitionAudit(patchObject.batch, {
      at: nowIso,
      transitionKey,
      fromExecutionState: currentState,
      nextExecutionState: nextState,
      reasonCode: reasonCode || null,
      actor: actor || null,
      metadata: metadata || null,
      expectedFenceToken: expectedFenceToken === null ? null : Number(expectedFenceToken),
    })
    : updatedBatch;

  const { batch: _ignoreBatchPatch, ...otherPatch } = patchObject;

  const moved = await guardedEditHistoryUpdate({
    id: operationId,
    shop,
    expectedStatuses: expectedStatuses.length ? expectedStatuses : undefined,
    expectedExecutionStates: expectedExecutionStates.length
      ? expectedExecutionStates
      : [currentState],
    expectedStateVersion: row?.stateVersion ?? 0,
    extraWhere: expectedFenceToken === null
      ? {}
      : {
        batch: {
          path: ["executeLeaseFencingToken"],
          equals: Number(expectedFenceToken),
        },
      },
    data: {
      executionState: nextState,
      executionStateNormalized: normalizeEditHistoryExecutionState(nextState),
      ...(derivedStatus ? {
        status: derivedStatus,
        statusNormalized: normalizeEditHistoryStatus(derivedStatus),
      } : {}),
      ...(inferTerminalizedAt(nextState) ? { completedAt: new Date() } : {}),
      batch: mergedBatchPatch,
      ...otherPatch,
    },
    db: client,
  });

  if (!moved || !moved.success) return { ok: false, reason: "STALE_STATE_OR_FENCE", currentState, nextState };
  return { ok: true, currentState, nextState };
}
