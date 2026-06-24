import readline from "node:readline";
import { Readable } from "node:stream";
import crypto from "crypto";
import { db } from "../../repositories/repositoryDb.js";
import { Prisma } from "../../repositories/prismaTypes.js";
import {
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import {
  acquireOperationLease,
  buildLeaseOwnerId,
  heartbeatOperationLease,
  releaseOperationLease,
} from "../operationLeaseService.js";
import { guardedEditHistoryUpdate } from "../operationTransitionGuards.js";
import { transitionOperation } from "../operationTransitionService.js";
import { applyMirrorFromSuccessfulChangeRecords } from "./BulkEditMirrorApplyService.js";
import { schedulePostMutationMirrorReconciliation } from "../mirrorReconciliationService.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";

function normalizeTargetIdentity(row) {
  return String(
    row?.targetIdentity
      || row?.target?.identity
      || "",
  ).trim() || null;
}

function extractRowResult(row = {}, fallbackTargetIdentity = null) {
  const payload = row?.data && typeof row.data === "object" ? row.data : row;
  const productSet = payload?.productSet || null;
  const userErrors =
    payload?.userErrors
    || productSet?.userErrors
    || productSet?.productSetOperation?.userErrors
    || payload?.product?.userErrors
    || [];
  const normalizedErrors = Array.isArray(userErrors) ? userErrors : [];

  const targetIdentity = normalizeTargetIdentity(row) || fallbackTargetIdentity;
  const product = productSet?.product || payload?.product || null;
  const productIdRaw = payload?.productId || payload?.id || product?.id || null;
  const variantIdRaw = payload?.variantId || payload?.variant?.id || null;

  return {
    targetIdentity,
    productId: productIdRaw ? String(productIdRaw) : null,
    variantId: variantIdRaw ? String(variantIdRaw) : null,
    status: normalizedErrors.length > 0 ? "FAILED" : "SUCCESS",
    shopifyUserErrors: normalizedErrors,
  };
}

async function processJsonlLines(url, onRow) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Shopify result JSONL: ${response.status}`);
  }
  const body = response.body;
  if (!body) {
    throw new Error("Shopify result body is empty");
  }

  const nodeStream = Readable.fromWeb(body);
  const rl = readline.createInterface({ input: nodeStream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    // eslint-disable-next-line no-await-in-loop
    await onRow(trimmed);
  }
}

async function processJsonlLinesFromOffset(url, rowOffset, onRow) {
  let currentRow = 0;
  await processJsonlLines(url, async (line) => {
    currentRow += 1;
    if (currentRow <= Number(rowOffset || 0)) return;
    await onRow(line, currentRow);
  });
}

function mergeBatch(existingBatch, patch) {
  return {
    ...(existingBatch && typeof existingBatch === "object" ? existingBatch : {}),
    ...patch,
  };
}

function checkpointChecksum(prevChecksum, entry) {
  return crypto
    .createHash("sha256")
    .update(`${String(prevChecksum || "")}|${String(entry || "")}`)
    .digest("hex");
}

export class BulkEditResultIngestionService {
  async ingestCompletedBulkOperation({
    shop,
    historyId,
    executionId = null,
    bulkOperationId,
    resultUrl,
    attempt = 1,
    existingLeaseOwnerId = null,
  }) {
    const ownsLease = !existingLeaseOwnerId;
    const leaseOwnerId = existingLeaseOwnerId || buildLeaseOwnerId("bulk-edit-result-ingest");
    if (ownsLease) {
      const lease = await acquireOperationLease({
        shop,
        namespace: "BULK_EDIT_RESULT_INGEST",
        resourceId: String(historyId),
        ownerId: leaseOwnerId,
      });
      if (!lease?.acquired) {
        throw new Error("RESULT_INGEST_LEASE_CONFLICT");
      }
    }
    const leaseHeartbeat = ownsLease
      ? setInterval(() => {
        heartbeatOperationLease({
          shop,
          namespace: "BULK_EDIT_RESULT_INGEST",
          resourceId: String(historyId),
          ownerId: leaseOwnerId,
        }).catch(() => {});
      }, 30_000)
      : null;
    try {
    const history = await db.editHistory.findUnique({
      where: { id: historyId },
      select: {
        id: true,
        shop: true,
        executionIdentity: true,
        batch: true,
        bulkOperationId: true,
        processingBatchId: true,
      },
    });

    if (!history) throw new Error("Edit history not found");
    if (history.shop !== shop) throw new Error("SHOP_MISMATCH");
    if (executionId && history.executionIdentity && executionId !== history.executionIdentity) {
      throw new Error("STALE_EXECUTION_JOB");
    }

    const submittedBulkOperationId = history.batch?.shopifyBulkOperation?.id || history.bulkOperationId;
    if (!submittedBulkOperationId || String(submittedBulkOperationId) !== String(bulkOperationId)) {
      throw new Error("SHOPIFY_BULK_OPERATION_MISMATCH");
    }
    if (history.batch?.resultIngestion?.ingestedAt) {
      return {
        skipped: true,
        reason: "already_ingested",
        historyId,
        shop,
      };
    }

    const batchId =
      history.batch?.submittedBatchId
      || history.batch?.shopifyBulkOperation?.batchId
      || history.processingBatchId
      || null;

    const ingestingTransition = await transitionOperation({
      shop,
      operationId: historyId,
      expectedExecutionStates: [
        OPERATION_LIFECYCLE_STATES.QUEUED,
        OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
        OPERATION_LIFECYCLE_STATES.EXECUTING,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_BULK_SUBMITTED,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
        OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      ],
      nextExecutionState: OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      expectedFenceToken: Number(history.batch?.executeLeaseFencingToken || 0),
      transitionKey: "bulk_result_ingest_started",
      actor: { type: "worker", id: "bulkEditResultIngestionService" },
      reasonCode: "SHOPIFY_BULK_RESULT_AVAILABLE",
      metadata: { bulkOperationId, attempt, historyId },
      db: db,
    });
    if (!ingestingTransition?.ok) {
      return {
        skipped: true,
        reason: "ingestion_state_claim_lost",
        historyId,
        shop,
      };
    }

    const existingInProgressCheckpoint = await db.editHistoryIngestionCheckpoint.findFirst({
      where: {
        shop,
        historyId,
        status: "IN_PROGRESS",
      },
      orderBy: { updatedAt: "desc" },
    });

    const ingestionRunId = String(
      existingInProgressCheckpoint?.ingestionRunId
      || `${historyId}:${batchId || "none"}:${attempt}`,
    );

    let successCount = Number(existingInProgressCheckpoint?.successCount || 0);
    let failureCount = Number(existingInProgressCheckpoint?.failureCount || 0);
    let rowCount = Number(existingInProgressCheckpoint?.rowCount || 0);
    let unmappedRowCount = Number(existingInProgressCheckpoint?.unmappedRowCount || 0);
    let malformedRowCount = Number(existingInProgressCheckpoint?.malformedRowCount || 0);
    const checkpoint = {
      checkpointVersion: 2,
      ingestionRunId,
      attempt,
      rowOffset: Number(existingInProgressCheckpoint?.rowOffset || 0),
      rowCount,
      successCount,
      failureCount,
      unmappedRowCount,
      malformedRowCount,
      rollingChecksum: String(existingInProgressCheckpoint?.rollingChecksum || ""),
      updatedAt: new Date().toISOString(),
    };

    await db.editHistoryIngestionCheckpoint.upsert({
      where: {
        shop_historyId_ingestionRunId: {
          shop,
          historyId,
          ingestionRunId,
        },
      },
      create: {
        shop,
        historyId,
        ingestionRunId,
        attempt: Number(attempt || 1),
        status: "IN_PROGRESS",
        rowOffset: Number(checkpoint.rowOffset || 0),
        rowCount,
        successCount,
        failureCount,
        unmappedRowCount,
        malformedRowCount,
        rollingChecksum: checkpoint.rollingChecksum,
        metadata: {
          bulkOperationId,
          batchId,
        },
      },
      update: {
        attempt: Number(attempt || 1),
        status: "IN_PROGRESS",
        rowOffset: Number(checkpoint.rowOffset || 0),
        rowCount,
        successCount,
        failureCount,
        unmappedRowCount,
        malformedRowCount,
        rollingChecksum: checkpoint.rollingChecksum,
        metadata: {
          bulkOperationId,
          batchId,
        },
      },
    });

    const pendingUpdates = [];
    const FLUSH_SIZE = 500;
    const batchChangeRecords = await db.changeRecord.findMany({
      where: {
        editHistoryId: historyId,
        shop,
        ...(batchId ? { batchId } : {}),
      },
      select: {
        targetIdentity: true,
        status: true,
        options: true,
      },
    });
    const targetIdentityByLineNumber = new Map(
      batchChangeRecords.map((record, index) => {
        const configured = Number(record?.options?.shopifyBulkLineNumber);
        const lineNumber = Number.isInteger(configured) ? configured : index;
        return [lineNumber, record.targetIdentity];
      }),
    );
    const changeRecordByTargetIdentity = new Map(
      batchChangeRecords.map((record) => [record.targetIdentity, record]),
    );
    const snapshotSetId = String(
      history.batch?.targetSnapshotRef?.snapshotSetId || "",
    ).trim();

    const flushCheckpoint = async () => {
      checkpoint.rowOffset = rowCount;
      checkpoint.rowCount = rowCount;
      checkpoint.successCount = successCount;
      checkpoint.failureCount = failureCount;
      checkpoint.unmappedRowCount = unmappedRowCount;
      checkpoint.malformedRowCount = malformedRowCount;
      checkpoint.updatedAt = new Date().toISOString();

      await db.editHistoryIngestionCheckpoint.updateMany({
        where: {
          shop,
          historyId,
          ingestionRunId,
          status: "IN_PROGRESS",
        },
        data: {
          rowOffset: Number(checkpoint.rowOffset || 0),
          rowCount: Number(checkpoint.rowCount || 0),
          successCount: Number(checkpoint.successCount || 0),
          failureCount: Number(checkpoint.failureCount || 0),
          unmappedRowCount: Number(checkpoint.unmappedRowCount || 0),
          malformedRowCount: Number(checkpoint.malformedRowCount || 0),
          rollingChecksum: String(checkpoint.rollingChecksum || ""),
          metadata: {
            bulkOperationId,
            batchId,
            checkpointVersion: checkpoint.checkpointVersion,
          },
        },
      });
    };

    const flushPending = async () => {
      if (!pendingUpdates.length) return;
      const updates = pendingUpdates.splice(0, pendingUpdates.length);
      const txOps = updates.map((item) => {
        const existingRecord = changeRecordByTargetIdentity.get(item.targetIdentity);
        return db.changeRecord.updateMany({
          where: {
            editHistoryId: historyId,
            shop,
            ...(batchId ? { batchId } : {}),
            targetIdentity: item.targetIdentity,
            status: { in: ["pending", "PENDING", "failed", "FAILED"] },
          },
          data: {
            status: item.status,
            failureCode: item.status === "FAILED" ? "SHOPIFY_USER_ERRORS" : null,
            failureMessage: item.status === "FAILED"
              ? JSON.stringify(item.shopifyUserErrors || [])
              : null,
            options: {
              ...(existingRecord?.options && typeof existingRecord.options === "object"
                ? existingRecord.options
                : {}),
              attempt,
              shopifyUserErrors: item.shopifyUserErrors || [],
            },
          },
        });
      });
      const results = await db.$transaction(txOps);
      for (let i = 0; i < results.length; i += 1) {
        const count = Number(results[i]?.count || 0);
        const row = updates[i];
        if (!count) {
          const existingStatus = String(
            changeRecordByTargetIdentity.get(row.targetIdentity)?.status || "",
          ).toUpperCase();
          if (
            row.status === "SUCCESS"
            && ["SUCCESS", "SUCCEEDED", "VERIFIED"].includes(existingStatus)
          ) {
            // A previous attempt may have committed the row before its history/checkpoint
            // write. Treat that durable success as idempotent instead of data corruption.
            successCount += 1;
            continue;
          }
          unmappedRowCount += 1;
          continue;
        }
        changeRecordByTargetIdentity.set(row.targetIdentity, {
          ...(changeRecordByTargetIdentity.get(row.targetIdentity) || {}),
          status: row.status,
        });
        if (snapshotSetId) {
          // eslint-disable-next-line no-await-in-loop
          await db.targetSnapshotItem.updateMany({
            where: {
              shop,
              snapshotSetId,
              targetKey: row.targetIdentity,
            },
            data: {
              executionStatus: row.status === "SUCCESS" ? "SUCCEEDED" : "FAILED",
              shopifyErrorCode: row.status === "FAILED" ? "SHOPIFY_USER_ERRORS" : null,
              shopifyErrorMessage: row.status === "FAILED"
                ? JSON.stringify(row.shopifyUserErrors || []).slice(0, 1000)
                : null,
              executedAt: new Date(),
            },
          });
        }
        if (row.status === "SUCCESS") successCount += count;
        else failureCount += count;
      }
      await flushCheckpoint();
    };

    await processJsonlLinesFromOffset(resultUrl, checkpoint.rowOffset, async (line, absoluteRow) => {
      rowCount = Number(absoluteRow || (rowCount + 1));
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformedRowCount += 1;
        checkpoint.rollingChecksum = checkpointChecksum(
          checkpoint.rollingChecksum,
          `malformed:${rowCount}:${line.slice(0, 256)}`,
        );
        await flushCheckpoint();
        return;
      }
      const lineNumber = Number.isInteger(Number(parsed?.__lineNumber))
        ? Number(parsed.__lineNumber)
        : rowCount - 1;
      const item = extractRowResult(
        parsed,
        targetIdentityByLineNumber.get(lineNumber) || null,
      );
      if (!item.targetIdentity) {
        unmappedRowCount += 1;
        checkpoint.rollingChecksum = checkpointChecksum(
          checkpoint.rollingChecksum,
          `unmapped:${rowCount}`,
        );
        await flushCheckpoint();
        return;
      }
      checkpoint.rollingChecksum = checkpointChecksum(
        checkpoint.rollingChecksum,
        `${rowCount}:${item.targetIdentity}:${item.status}`,
      );

      pendingUpdates.push({
        targetIdentity: item.targetIdentity,
        status: item.status === "SUCCESS" ? "SUCCESS" : "FAILED",
        shopifyUserErrors: item.shopifyUserErrors || [],
      });
      if (pendingUpdates.length >= FLUSH_SIZE) {
        await flushPending();
      }
    });
    await flushPending();
    await flushCheckpoint();

    if (malformedRowCount > 0) {
      await db.editHistoryIngestionCheckpoint.updateMany({
        where: { shop, historyId, ingestionRunId, status: "IN_PROGRESS" },
        data: {
          status: "FAILED",
          metadata: {
            bulkOperationId,
            batchId,
            failureCode: "MALFORMED_RESULT_JSONL_ROWS",
          },
        },
      });
      await db.editHistory.updateMany({
        where: { id: historyId, shop },
        data: {
          batch: mergeBatch(history.batch, {
            resultIngestionFailure: {
              code: "MALFORMED_RESULT_JSONL_ROWS",
              malformedRowCount,
              rowCount,
              ingestionRunId,
              checkpoint,
              failedAt: new Date().toISOString(),
            },
          }),
        },
      });
      throw new Error(`MALFORMED_RESULT_JSONL_ROWS:${malformedRowCount}`);
    }

    if (unmappedRowCount > 0) {
      await db.editHistoryIngestionCheckpoint.updateMany({
        where: { shop, historyId, ingestionRunId, status: "IN_PROGRESS" },
        data: {
          status: "FAILED",
          metadata: {
            bulkOperationId,
            batchId,
            failureCode: "UNMAPPED_RESULT_ROWS",
          },
        },
      });
      await db.editHistory.updateMany({
        where: { id: historyId, shop },
        data: {
          batch: mergeBatch(history.batch, {
            resultIngestionFailure: {
              code: "UNMAPPED_RESULT_ROWS",
              unmappedRowCount,
              rowCount,
              ingestionRunId,
              checkpoint,
              failedAt: new Date().toISOString(),
            },
          }),
        },
      });
      throw new Error(`UNMAPPED_RESULT_ROWS:${unmappedRowCount}`);
    }

    const completedUpdate = await guardedEditHistoryUpdate({
      id: historyId,
      shop,
      expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS],
      extraWhere: {
        batch: {
          path: ["resultIngestion", "ingestedAt"],
          // A never-ingested JSON path is SQL NULL (DbNull), not JSON null.
          // Using plain null makes the CAS match zero rows and strands the
          // operation in INGESTING_RESULTS after its item writes succeed.
          equals: Prisma.DbNull,
        },
      },
      data: {
        processedCount: {
          increment: successCount + failureCount,
        },
        status: failureCount > 0 ? "partial" : "completed",
        statusNormalized: normalizeEditHistoryStatus(failureCount > 0 ? "partial" : "completed"),
        batch: mergeBatch(history.batch, {
          resultIngestion: {
            ingestedAt: new Date().toISOString(),
            batchId,
            ingestionRunId,
            successCount,
            failureCount,
            unmappedRowCount,
            malformedRowCount,
            rowCount,
            rollingChecksum: checkpoint.rollingChecksum,
            checkpoint,
          },
        }),
      },
      db: db,
    });
    if (!completedUpdate) {
      return {
        skipped: true,
        reason: "already_ingested",
        historyId,
        shop,
        batchId,
        successCount: 0,
        failureCount: 0,
        unmappedRowCount: 0,
        malformedRowCount: 0,
        rowCount: 0,
      };
    }

    await clearKeyCaches(`${shop}:historyChanges:${historyId}:`).catch(() => {});

    const mirrorApplyResult = await applyMirrorFromSuccessfulChangeRecords({
      shop,
      historyId,
    });

    // completedUpdate persisted resultIngestion above. Merge mirror metadata into the
    // latest batch value so this follow-up write cannot erase the ingestion marker.
    const latestHistoryForMirrorApply = await db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: { batch: true },
    });
    await db.editHistory.updateMany({
      where: { id: historyId, shop },
      data: {
        batch: mergeBatch(latestHistoryForMirrorApply?.batch, {
          mirrorApply: {
            status: "APPLIED_PENDING_RECONCILE",
            attemptedRows: Number(mirrorApplyResult?.attemptedRows || 0),
            appliedRows: Number(mirrorApplyResult?.appliedRows || 0),
            unresolvedRows: Number(mirrorApplyResult?.unresolvedRows || 0),
            appliedProductRows: Number(mirrorApplyResult?.appliedProductRows || 0),
            appliedVariantRows: Number(mirrorApplyResult?.appliedVariantRows || 0),
            mirrorBatchId: mirrorApplyResult?.mirrorBatchId || null,
            appliedAt: new Date().toISOString(),
          },
        }),
      },
    });

    await schedulePostMutationMirrorReconciliation({
      shop,
      ownerType: "EDIT_HISTORY",
      ownerId: historyId,
      mirrorBatchId: mirrorApplyResult?.mirrorBatchId || undefined,
      source: "BULK_EDIT_EXECUTION_APPLY",
      verificationStatus: failureCount > 0 ? "PARTIAL" : "SUCCESS",
    });

    await transitionOperation({
      shop,
      operationId: historyId,
      expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS],
      nextExecutionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
      expectedFenceToken: Number(history.batch?.executeLeaseFencingToken || 0),
      transitionKey: "bulk_result_ingest_completed",
      actor: { type: "worker", id: "bulkEditResultIngestionService" },
      reasonCode: failureCount > 0 ? "SHOPIFY_RESULT_PARTIAL" : "SHOPIFY_RESULT_COMPLETE",
      metadata: { bulkOperationId, successCount, failureCount, ingestionRunId },
      db: db,
    });

    await db.editHistoryIngestionCheckpoint.updateMany({
      where: { shop, historyId, ingestionRunId, status: "IN_PROGRESS" },
      data: {
        status: "COMPLETED",
        rowOffset: Number(rowCount || 0),
        rowCount: Number(rowCount || 0),
        successCount: Number(successCount || 0),
        failureCount: Number(failureCount || 0),
        unmappedRowCount: Number(unmappedRowCount || 0),
        malformedRowCount: Number(malformedRowCount || 0),
        rollingChecksum: String(checkpoint.rollingChecksum || ""),
        metadata: {
          bulkOperationId,
          batchId,
          completedAt: new Date().toISOString(),
        },
      },
    });

    return {
      historyId,
      shop,
      batchId,
      successCount,
      failureCount,
      unmappedRowCount,
      malformedRowCount,
      rowCount,
      rollingChecksum: checkpoint.rollingChecksum,
    };
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      if (ownsLease) {
        await releaseOperationLease({
          shop,
          namespace: "BULK_EDIT_RESULT_INGEST",
          resourceId: String(historyId),
          ownerId: leaseOwnerId,
        });
      }
    }
  }
}

