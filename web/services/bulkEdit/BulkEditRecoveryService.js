import { db } from "../../repositories/repositoryDb.js";
import { addbulkEditResultIngestJob } from "../../Jobs/Queues/bulkEditResultIngestJob.js";
import { enqueueBulkEditVerification } from "../../queues/adapters/bulkEditVerificationQueueAdapter.js";
import logger from "../../utils/loggerUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import { transitionOperation } from "../operationTransitionService.js";
import {
  acquireOperationLease,
  buildLeaseOwnerId,
  releaseOperationLease,
} from "../operationLeaseService.js";
import { normalizeEditHistoryExecutionState } from "../../utils/normalizedStateUtils.js";

const TERMINAL_RECOVERY_BLOCKED_STATES = new Set([
  OPERATION_LIFECYCLE_STATES.COMPLETED,
  OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
  OPERATION_LIFECYCLE_STATES.FAILED,
  OPERATION_LIFECYCLE_STATES.CANCELLED,
  OPERATION_LIFECYCLE_STATES.UNDO_COMPLETED,
  OPERATION_LIFECYCLE_STATES.ROLLED_BACK,
  OPERATION_LIFECYCLE_STATES.ROLLBACK_FAILED,
]);

const VERIFY_RECOVERY_STATES = new Set([
  OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
  OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
  OPERATION_LIFECYCLE_STATES.VERIFYING,
  OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
  OPERATION_LIFECYCLE_STATES.VERIFICATION_TIMEOUT,
]);

const INGEST_RECOVERY_STATES = new Set([
  OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
  OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
  OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
]);

function assertAdminRecoveryActor(actor) {
  if (!actor || String(actor.actorType || "") !== "ADMIN_RECOVERY") {
    throw new Error("RECOVERY_ACTOR_SCOPE_REQUIRED");
  }
  if (!String(actor.actorId || "").trim() && !String(actor.actorEmail || "").trim()) {
    throw new Error("RECOVERY_ACTOR_ID_REQUIRED");
  }
}

function normalizeMode(mode) {
  const selected = String(mode || "auto").trim().toLowerCase();
  if (!["auto", "verify", "ingest"].includes(selected)) {
    throw new Error(`BULK_EDIT_RECOVERY_UNSUPPORTED_MODE:${selected}`);
  }
  return selected;
}

function resolveBulkOperationId(history) {
  return String(
    history?.batch?.shopifyBulkOperation?.id
      || history?.batch?.shopifyBulkOperationId
      || history?.bulkOperationId
      || "",
  ).trim();
}

function selectRecoveryMode({ selectedMode, currentState, history }) {
  if (selectedMode === "verify") return "verify";
  if (selectedMode === "ingest") return "ingest";
  if (
    currentState === OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS
    || currentState === OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING
    || (
      currentState === OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED
      && resolveBulkOperationId(history)
    )
  ) {
    return "ingest";
  }
  if (VERIFY_RECOVERY_STATES.has(currentState)) return "verify";
  throw new Error(`BULK_EDIT_RECOVERY_UNSUPPORTED_STATE:${currentState}`);
}

async function defaultEnqueueVerification({ historyId, shop, executionId }) {
  await enqueueBulkEditVerification({
    historyId,
    shop,
    executionId,
    source: "admin_recovery_verify",
  });
}

async function defaultEnqueueResultIngest({ shop, bulkOperationId, executionId }) {
  await addbulkEditResultIngestJob({
    shop,
    bulkOperationId,
    executionId,
    source: "admin_recovery_ingest",
  });
}

export class BulkEditRecoveryService {
  constructor(deps = {}) {
    this.db = deps.db || db;
    this.logger = deps.logger || logger;
    this.acquireOperationLease = deps.acquireOperationLease || acquireOperationLease;
    this.releaseOperationLease = deps.releaseOperationLease || releaseOperationLease;
    this.transitionOperation = deps.transitionOperation || transitionOperation;
    this.enqueueVerification = deps.enqueueVerification || defaultEnqueueVerification;
    this.enqueueResultIngest = deps.enqueueResultIngest || defaultEnqueueResultIngest;
  }

  async #writeAudit({
    shop,
    historyId,
    mode,
    reason,
    actor,
    result,
    metadata = {},
  }) {
    try {
      await this.db.bulkEditRecoveryAudit.create({
        data: {
          shop,
          historyId,
          mode,
          reason,
          actorType: actor?.actorType || null,
          actorId: actor?.actorId || null,
          actorEmail: actor?.actorEmail || null,
          result,
          metadata,
        },
      });
    } catch (error) {
      this.logger.error("Bulk edit recovery audit write failed", {
        shop,
        historyId,
        mode,
        result,
        message: error?.message || String(error),
      });
      throw new Error("BULK_EDIT_RECOVERY_AUDIT_WRITE_FAILED");
    }
  }

  async #rollbackRecoveryState({ shop, historyId, fromState, toState }) {
    if (!fromState || !toState || fromState === toState) return;
    await this.db.editHistory.updateMany({
      where: {
        id: historyId,
        shop,
        executionState: fromState,
      },
      data: {
        executionState: toState,
        executionStateNormalized: normalizeEditHistoryExecutionState(toState),
      },
    });
  }

  async #executeRecoveryMode({
    shop,
    history,
    mode,
    reason,
    actor,
    currentState,
  }) {
    const bulkOperationId = mode === "ingest" ? resolveBulkOperationId(history) : null;
    if (mode === "ingest" && !bulkOperationId) {
      throw new Error("BULK_EDIT_RECOVERY_BULK_OPERATION_ID_REQUIRED");
    }

    const expectedExecutionStates =
      mode === "verify"
        ? [...VERIFY_RECOVERY_STATES]
        : [...INGEST_RECOVERY_STATES];

    const recoveryNextState =
      mode === "verify" && currentState === OPERATION_LIFECYCLE_STATES.VERIFICATION_TIMEOUT
        ? OPERATION_LIFECYCLE_STATES.VERIFYING
        : currentState;
    const moved = await this.transitionOperation({
      shop,
      operationId: history.id,
      expectedExecutionStates,
      nextExecutionState: recoveryNextState,
      transitionKey: `admin_recovery_${mode}`,
      reasonCode: `ADMIN_RECOVERY_${mode.toUpperCase()}`,
      actor,
      metadata: {
        mode,
        reason,
        ...(bulkOperationId ? { bulkOperationId } : {}),
      },
      dataPatch: currentState === OPERATION_LIFECYCLE_STATES.VERIFICATION_TIMEOUT
        ? {
          status: "processing",
          statusNormalized: "PROCESSING",
          completedAt: null,
        }
        : {},
      db: this.db,
    });
    if (!moved?.ok) {
      await this.#writeAudit({
        shop,
        historyId: history.id,
        mode,
        reason,
        actor,
        result: "TRANSITION_REJECTED",
        metadata: { currentState, transitionReason: moved?.reason || null },
      });
      throw new Error(`BULK_EDIT_RECOVERY_${mode.toUpperCase()}_TRANSITION_REJECTED`);
    }

    try {
      if (mode === "verify") {
        await this.enqueueVerification({
          historyId: history.id,
          shop,
          executionId: history.executionIdentity || null,
        });
      } else {
        await this.enqueueResultIngest({
          shop,
          bulkOperationId,
          executionId: history.executionIdentity || null,
        });
      }
    } catch (error) {
      await this.#rollbackRecoveryState({
        shop,
        historyId: history.id,
        fromState: moved.nextState,
        toState: moved.currentState,
      });
      await this.#writeAudit({
        shop,
        historyId: history.id,
        mode,
        reason,
        actor,
        result: "ENQUEUE_FAILED",
        metadata: {
          fromState: currentState,
          bulkOperationId,
          message: error?.message || String(error),
        },
      });
      throw error;
    }

    await this.#writeAudit({
      shop,
      historyId: history.id,
      mode,
      reason,
      actor,
      result: "RECOVERED",
      metadata: {
        fromState: currentState,
        bulkOperationId,
      },
    });

    return {
      recovered: true,
      mode,
      historyId: history.id,
      shop,
      ...(bulkOperationId ? { bulkOperationId } : {}),
    };
  }

  async recoverStuckState({
    shop,
    historyId,
    mode = "auto",
    reason = "",
    actor = null,
  }) {
    const safeShop = String(shop || "").trim();
    const safeHistoryId = String(historyId || "").trim();
    if (!safeShop || !safeHistoryId) {
      throw new Error("BULK_EDIT_RECOVERY_SCOPE_REQUIRED");
    }

    const recoveryReason = String(reason || "").trim();
    if (!recoveryReason) {
      throw new Error("RECOVERY_REASON_REQUIRED");
    }
    assertAdminRecoveryActor(actor);
    const selectedMode = normalizeMode(mode);

    const store = await this.db.store.findUnique({
      where: { shopUrl: safeShop },
      select: { shopUrl: true },
    });
    if (!store) {
      throw new Error("BULK_EDIT_RECOVERY_SHOP_NOT_FOUND");
    }

    const leaseOwnerId = buildLeaseOwnerId("bulk-edit-recovery");
    const lease = await this.acquireOperationLease({
      shop: safeShop,
      namespace: "BULK_EDIT_RECOVERY",
      resourceId: safeHistoryId,
      ownerId: leaseOwnerId,
    });
    if (!lease?.acquired) {
      throw new Error("BULK_EDIT_RECOVERY_LEASE_CONFLICT");
    }

    try {
      const history = await this.db.editHistory.findFirst({
        where: { id: safeHistoryId, shop: safeShop },
        select: {
          id: true,
          shop: true,
          executionIdentity: true,
          executionState: true,
          batch: true,
          bulkOperationId: true,
          updatedAt: true,
        },
      });
      if (!history) throw new Error("EDIT_HISTORY_NOT_FOUND");

      const currentState = String(history.executionState || "").toUpperCase();
      if (TERMINAL_RECOVERY_BLOCKED_STATES.has(currentState)) {
        await this.#writeAudit({
          shop: safeShop,
          historyId: safeHistoryId,
          mode: selectedMode,
          reason: recoveryReason,
          actor,
          result: "TERMINAL_STATE_BLOCKED",
          metadata: { currentState },
        });
        throw new Error(`BULK_EDIT_RECOVERY_TERMINAL_STATE_BLOCKED:${currentState}`);
      }

      const resolvedMode = selectRecoveryMode({
        selectedMode,
        currentState,
        history,
      });

      return this.#executeRecoveryMode({
        shop: safeShop,
        history,
        mode: resolvedMode,
        reason: recoveryReason,
        actor,
        currentState,
      });
    } catch (error) {
      if (String(error?.message || "").startsWith("BULK_EDIT_RECOVERY_UNSUPPORTED_STATE")) {
        await this.#writeAudit({
          shop: safeShop,
          historyId: safeHistoryId,
          mode: selectedMode,
          reason: recoveryReason,
          actor,
          result: "UNSUPPORTED_STATE",
          metadata: { message: error.message },
        });
      }
      throw error;
    } finally {
      await this.releaseOperationLease({
        shop: safeShop,
        namespace: "BULK_EDIT_RECOVERY",
        resourceId: safeHistoryId,
        ownerId: leaseOwnerId,
      });
    }
  }
}

export default BulkEditRecoveryService;
