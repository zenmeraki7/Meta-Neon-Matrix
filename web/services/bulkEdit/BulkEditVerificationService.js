import { prisma } from "../../config/database.js";
import shopify from "../../shopify.js";
import { getSession } from "../../utils/sessionHandler.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import { schedulePostMutationMirrorReconciliation } from "../mirrorReconciliationService.js";
import { upsertOperationStageProgress } from "../operationStageProgressService.js";

const VERIFY_MODES = Object.freeze({
  NONE: "NONE",
  SAMPLE_ONLY: "SAMPLE_ONLY",
  SAMPLE_PLUS_FAILURES: "SAMPLE_PLUS_FAILURES",
  FULL_FOR_SMALL_BATCH: "FULL_FOR_SMALL_BATCH",
  FULL: "FULL",
});

function pickVerificationMode(history) {
  const configured = String(history?.batch?.verificationMode || "").toUpperCase();
  if (Object.values(VERIFY_MODES).includes(configured)) return configured;

  const count = Number(history?.batch?.currentBatchTargetCount || history?.targetSnapshotCount || 0);
  const destructive = Array.isArray(history?.rules)
    && history.rules.some((rule) => String(rule?.field || "") === "deleteProducts");
  const risk = String(history?.batch?.blastRadiusAssessment?.riskLevel || "").toUpperCase();

  if (destructive || risk === "CRITICAL") return VERIFY_MODES.FULL;
  if (count > 0 && count <= 100) return VERIFY_MODES.FULL_FOR_SMALL_BATCH;
  return VERIFY_MODES.SAMPLE_PLUS_FAILURES;
}

function stableScore(seed, value) {
  const key = `${seed}:${value}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicSample(rows, limit, seed) {
  const list = Array.isArray(rows) ? [...rows] : [];
  if (list.length <= limit) return list;
  return list
    .map((row) => ({
      row,
      score: stableScore(seed, row.targetIdentity || row.id),
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((item) => item.row);
}

function toNodeId(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  return value.startsWith("gid://") ? value : null;
}

const VERIFY_NODES_QUERY = `#graphql
  query VerifyNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      id
      ... on Product {
        title
        status
        vendor
        productType
        handle
      }
      ... on ProductVariant {
        id
        sku
        barcode
        price
        compareAtPrice
        inventoryQuantity
      }
    }
  }
`;

async function fetchShopifyNodesByIds(shop, ids = []) {
  const session = await getSession(shop);
  if (!session?.shop || session.shop !== shop) {
    throw new Error("Shop session not available for verification");
  }
  const client = new shopify.api.clients.Graphql({ session });
  const uniqueIds = [...new Set(ids.map(toNodeId).filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const chunkSize = 100;
  const nodeMap = new Map();
  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    const chunk = uniqueIds.slice(index, index + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const response = await client.query({
      data: {
        query: VERIFY_NODES_QUERY,
        variables: { ids: chunk },
      },
    });
    const nodes = response?.body?.data?.nodes || [];
    for (const node of nodes) {
      if (node?.id) {
        nodeMap.set(String(node.id), node);
      }
    }
  }

  return nodeMap;
}

function readExpectedFromAfterValues(afterValues = {}) {
  const productFieldChanges = Array.isArray(afterValues?.productFieldChanges)
    ? afterValues.productFieldChanges
    : [];
  const variantFieldChanges = Array.isArray(afterValues?.variantFieldChanges)
    ? afterValues.variantFieldChanges
    : [];
  return { productFieldChanges, variantFieldChanges };
}

function compareSimpleExpected({ product, variantsById, expected }) {
  const mismatches = [];
  for (const item of expected.productFieldChanges) {
    const field = item?.field;
    if (!field) continue;
    const current = product?.[field] ?? null;
    const wanted = item?.newValue ?? null;
    if (String(current) !== String(wanted)) {
      mismatches.push({ target: "product", field, expected: wanted, actual: current });
    }
  }

  for (const item of expected.variantFieldChanges) {
    const field = item?.field;
    const variantId = item?.variantId;
    if (!field || !variantId) continue;
    const variant = variantsById.get(variantId) || variantsById.get(String(variantId));
    const current = variant?.[field] ?? null;
    const wanted = item?.newValue ?? null;
    if (String(current) !== String(wanted)) {
      mismatches.push({ target: "variant", variantId, field, expected: wanted, actual: current });
    }
  }

  return mismatches;
}

export class BulkEditVerificationService {
  async verifyBatch({ shop, historyId, executionId = null }) {
    const history = await prisma.editHistory.findUnique({
      where: { id: historyId },
      select: {
        id: true,
        shop: true,
        executionIdentity: true,
        rules: true,
        batch: true,
        targetSnapshotCount: true,
      },
    });

    if (!history) throw new Error("Edit history not found");
    if (history.shop !== shop) throw new Error("SHOP_MISMATCH");
    if (executionId && history.executionIdentity && executionId !== history.executionIdentity) {
      throw new Error("STALE_EXECUTION_JOB");
    }

    const mode = pickVerificationMode(history);
    await upsertOperationStageProgress({
      shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: executionId || history.executionIdentity || null,
      stageKey: "VERIFICATION",
      stageStatus: mode === VERIFY_MODES.NONE ? "SKIPPED" : "RUNNING",
      detail: { mode },
      completed: mode === VERIFY_MODES.NONE,
    });
    if (mode === VERIFY_MODES.NONE) {
      return { historyId, shop, mode, skipped: true };
    }

    const batchId =
      history.batch?.submittedBatchId
      || history.batch?.shopifyBulkOperation?.batchId
      || history.batch?.currentBatchId
      || null;

    const rows = await prisma.changeRecord.findMany({
      where: {
        editHistoryId: historyId,
        shop,
        ...(batchId ? { batchId } : {}),
      },
      select: {
        id: true,
        productId: true,
        variantId: true,
        afterValues: true,
        status: true,
      },
    });

    const successes = rows.filter((row) => String(row.status || "").toUpperCase() === "SUCCESS");
    const failures = rows.filter((row) => String(row.status || "").toUpperCase() === "FAILED");

    let verifyRows = [];
    const seed = `${historyId}:${batchId || "none"}`;
    if (mode === VERIFY_MODES.FULL || mode === VERIFY_MODES.FULL_FOR_SMALL_BATCH) {
      verifyRows = [...successes];
    } else if (mode === VERIFY_MODES.SAMPLE_ONLY) {
      verifyRows = deterministicSample(
        successes,
        Math.max(1, Math.min(20, Math.ceil(successes.length * 0.1))),
        seed,
      );
    } else {
      verifyRows = [
        ...deterministicSample(
          successes,
          Math.max(1, Math.min(20, Math.ceil(successes.length * 0.1))),
          seed,
        ),
        ...failures,
      ];
    }

    const productIds = [...new Set(verifyRows.map((row) => row.productId).filter(Boolean))];
    const variantIds = [...new Set(verifyRows.map((row) => row.variantId).filter(Boolean))];

    const nodes = await fetchShopifyNodesByIds(shop, [...productIds, ...variantIds]);
    const productsById = new Map();
    const variantsById = new Map();
    for (const node of nodes.values()) {
      if (node?.__typename === "Product") {
        productsById.set(node.id, node);
      } else if (node?.__typename === "ProductVariant") {
        variantsById.set(node.id, node);
      }
    }

    let verified = 0;
    let failed = 0;
    const verifiedIds = [];
    const failedRows = [];
    for (const row of verifyRows) {
      const product = productsById.get(row.productId);
      const expected = readExpectedFromAfterValues(row.afterValues || {});
      const mismatches = compareSimpleExpected({ product, variantsById, expected });

      if (mismatches.length === 0) {
        verified += 1;
        verifiedIds.push(row.id);
      } else {
        failed += 1;
        failedRows.push({
          id: row.id,
          message: JSON.stringify(mismatches.slice(0, 20)),
        });
      }
    }

    const chunkSize = 500;
    for (let i = 0; i < verifiedIds.length; i += chunkSize) {
      const idChunk = verifiedIds.slice(i, i + chunkSize);
      // eslint-disable-next-line no-await-in-loop
      await prisma.changeRecord.updateMany({
        where: {
          shop,
          id: { in: idChunk },
        },
        data: {
          status: "VERIFIED",
          failureCode: null,
          failureMessage: null,
        },
      });
    }
    for (let i = 0; i < failedRows.length; i += chunkSize) {
      const batch = failedRows.slice(i, i + chunkSize);
      // eslint-disable-next-line no-await-in-loop
      await prisma.$transaction(
        batch.map((item) => prisma.changeRecord.updateMany({
          where: { id: item.id, shop },
          data: {
            status: "VERIFICATION_FAILED",
            failureCode: "VERIFICATION_MISMATCH",
            failureMessage: item.message,
          },
        })),
      );
    }

    await prisma.editHistory.updateMany({
      where: { id: historyId, shop },
      data: {
        executionState: OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
        ),
      },
    });

    const verificationStatus = failed > 0 ? "FAILED" : "SUCCESS";
    await schedulePostMutationMirrorReconciliation({
      shop,
      ownerType: "EDIT_HISTORY",
      ownerId: historyId,
      mirrorBatchId: history.batch?.previewFingerprint?.mirrorBatchId || null,
      source: "BULK_EDIT_VERIFICATION",
      verificationStatus,
    });

    const finalState = failed > 0
      ? OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED
      : OPERATION_LIFECYCLE_STATES.COMPLETED;
    const finalStatus = failed > 0 ? "partial" : "completed";

    const historyUpdate = await prisma.editHistory.updateMany({
      where: { id: historyId, shop },
      data: {
        status: finalStatus,
        statusNormalized: normalizeEditHistoryStatus(finalStatus),
        executionState: finalState,
        executionStateNormalized: normalizeEditHistoryExecutionState(finalState),
        completedAt: new Date(),
        batch: {
          ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
          verification: {
            mode,
            verifiedAt: new Date().toISOString(),
            verifiedCount: verified,
            verificationFailedCount: failed,
            sampledCount: verifyRows.length,
          },
        },
      },
    });
    if (historyUpdate.count !== 1) {
      throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_VERIFICATION_RESULT");
    }
    await upsertOperationStageProgress({
      shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: executionId || history.executionIdentity || null,
      stageKey: "VERIFICATION",
      stageStatus: failed > 0 ? "PARTIAL_FAILED" : "COMPLETED",
      counterA: verified,
      counterB: failed,
      counterC: verifyRows.length,
      detail: { mode },
      completed: true,
    });

    return {
      historyId,
      shop,
      mode,
      verified,
      verificationFailed: failed,
      sampledCount: verifyRows.length,
    };
  }
}
