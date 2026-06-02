import { db } from "../../repositories/repositoryDb.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import { transitionOperation } from "../operationTransitionService.js";
import {
  acquireOperationLease,
  buildLeaseOwnerId,
  releaseOperationLease,
} from "../operationLeaseService.js";
import { enqueueBulkEditVerification } from "../../queues/adapters/bulkEditVerificationQueueAdapter.js";

function assertAdminRecoveryActor(actor) {
  if (!actor || String(actor.actorType || "") !== "ADMIN_RECOVERY") {
    throw new Error("RECOVERY_ACTOR_SCOPE_REQUIRED");
  }
  if (!String(actor.actorId || "").trim() && !String(actor.actorEmail || "").trim()) {
    throw new Error("RECOVERY_ACTOR_ID_REQUIRED");
  }
}

export class BulkEditRecoveryService {
  constructor(deps = {}) {
    this.db = deps.db || db;
    this.acquireOperationLease = deps.acquireOperationLease || acquireOperationLease;
    this.releaseOperationLease = deps.releaseOperationLease || releaseOperationLease;
    this.transitionOperation = deps.transitionOperation || transitionOperation;
    this.enqueueVerification = deps.enqueueVerification || (async ({ historyId, shop, executionId }) => {
      await enqueueBulkEditVerification({
        historyId,
        shop,
        executionId,
        source: "admin_recovery_verify",
      });
    });
    this.enqueueResultIngest = deps.enqueueResultIngest || (async ({
      shop,
      bulkOperationId,
      executionId,
    }) => {
      const { addbulkEditResultIngestJob } = await import("../../Jobs/Queues/bulkEditResultIngestJob.js");
      await addbulkEditResultIngestJob({
        shop,
        bulkOperationId,
        executionId,
        source: "admin_recovery_ingest",
      });
    });
  }

  async recoverStuckState({
    shop,
    historyId,
    mode = "auto",
    reason = "",
    actor = null,
  }) {
    const recoveryReason = String(reason || "").trim();
    if (!recoveryReason) {
      throw new Error("RECOVERY_REASON_REQUIRED");
    }
    if (actor) {
      assertAdminRecoveryActor(actor);
    }
    const leaseOwnerId = buildLeaseOwnerId("bulk-edit-recovery");
    const lease = await this.acquireOperationLease({
      shop,
      namespace: "BULK_EDIT_RECOVERY",
      resourceId: String(historyId),
      ownerId: leaseOwnerId,
    });
    if (!lease?.acquired) {
      throw new Error("BULK_EDIT_RECOVERY_LEASE_CONFLICT");
    }

    try {
      const history = await this.db.editHistory.findFirst({
        where: { id: historyId, shop },
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

      const currentState = String(history.executionState || "");
      const selectedMode = String(mode || "auto").toLowerCase();

      if (
        selectedMode === "verify"
        || (selectedMode === "auto" && currentState === OPERATION_LIFECYCLE_STATES.VERIFYING)
      ) {
        const moved = await this.transitionOperation({
          shop,
          operationId: historyId,
          expectedExecutionStates: [
            OPERATION_LIFECYCLE_STATES.VERIFYING,
            OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
            OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
            OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
          ],
          nextExecutionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
          transitionKey: "admin_recovery_verify",
          reasonCode: "ADMIN_RECOVERY_VERIFY",
          allowTerminalOverride: true,
          actor,
          metadata: { mode: "verify", reason: recoveryReason },
          dataPatch: {
            batch: {
              ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
              recovery: {
                mode: "verify",
                recoveredAt: new Date().toISOString(),
                reason: recoveryReason,
              },
            },
          },
          db: this.db,
        });
        if (!moved?.ok) {
          await this.db.bulkEditRecoveryAudit.create({
            data: {
              shop,
              historyId,
              mode: "verify",
              reason: recoveryReason,
              actorType: actor?.actorType || null,
              actorId: actor?.actorId || null,
              actorEmail: actor?.actorEmail || null,
              result: "TRANSITION_REJECTED",
              metadata: { currentState },
            },
          }).catch(() => {});
          throw new Error("BULK_EDIT_RECOVERY_VERIFY_TRANSITION_REJECTED");
        }
        await this.enqueueVerification({
          historyId,
          shop,
          executionId: history.executionIdentity || null,
        });
        await this.db.bulkEditRecoveryAudit.create({
          data: {
            shop,
            historyId,
            mode: "verify",
            reason: recoveryReason,
            actorType: actor?.actorType || null,
            actorId: actor?.actorId || null,
            actorEmail: actor?.actorEmail || null,
            result: "RECOVERED",
            metadata: { fromState: currentState },
          },
        }).catch(() => {});
        return { recovered: true, mode: "verify", historyId, shop };
      }

      if (
        selectedMode === "ingest"
        || (selectedMode === "auto" && currentState === OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS)
      ) {
        const bulkOperationId = String(
          history.batch?.shopifyBulkOperation?.id
            || history.batch?.shopifyBulkOperationId
            || history.bulkOperationId
            || "",
        );
        if (!bulkOperationId) {
          throw new Error("BULK_EDIT_RECOVERY_BULK_OPERATION_ID_REQUIRED");
        }
        const moved = await this.transitionOperation({
          shop,
          operationId: historyId,
          expectedExecutionStates: [
            OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
            OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
            OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
          ],
          nextExecutionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
          transitionKey: "admin_recovery_ingest",
          reasonCode: "ADMIN_RECOVERY_INGEST",
          allowTerminalOverride: true,
          actor,
          metadata: { mode: "ingest", reason: recoveryReason, bulkOperationId },
          dataPatch: {
            batch: {
              ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
              recovery: {
                mode: "ingest",
                recoveredAt: new Date().toISOString(),
                reason: recoveryReason,
              },
            },
          },
          db: this.db,
        });
        if (!moved?.ok) {
          await this.db.bulkEditRecoveryAudit.create({
            data: {
              shop,
              historyId,
              mode: "ingest",
              reason: recoveryReason,
              actorType: actor?.actorType || null,
              actorId: actor?.actorId || null,
              actorEmail: actor?.actorEmail || null,
              result: "TRANSITION_REJECTED",
              metadata: { currentState },
            },
          }).catch(() => {});
          throw new Error("BULK_EDIT_RECOVERY_INGEST_TRANSITION_REJECTED");
        }
        await this.enqueueResultIngest({
          shop,
          bulkOperationId,
          executionId: history.executionIdentity || null,
        });
        await this.db.bulkEditRecoveryAudit.create({
          data: {
            shop,
            historyId,
            mode: "ingest",
            reason: recoveryReason,
            actorType: actor?.actorType || null,
            actorId: actor?.actorId || null,
            actorEmail: actor?.actorEmail || null,
            result: "RECOVERED",
            metadata: { fromState: currentState, bulkOperationId },
          },
        }).catch(() => {});
        return { recovered: true, mode: "ingest", historyId, shop, bulkOperationId };
      }

      await this.db.bulkEditRecoveryAudit.create({
        data: {
          shop,
          historyId,
          mode: selectedMode,
          reason: recoveryReason,
          actorType: actor?.actorType || null,
          actorId: actor?.actorId || null,
          actorEmail: actor?.actorEmail || null,
          result: "UNSUPPORTED_STATE",
          metadata: { currentState },
        },
      }).catch(() => {});
      throw new Error(`BULK_EDIT_RECOVERY_UNSUPPORTED_STATE:${currentState}`);
    } finally {
      await this.releaseOperationLease({
        shop,
        namespace: "BULK_EDIT_RECOVERY",
        resourceId: String(historyId),
        ownerId: leaseOwnerId,
      });
    }
  }
}

export default BulkEditRecoveryService;

