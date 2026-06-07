import { db } from "../../repositories/repositoryDb.js";
import shopify from "../../shopify.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import { schedulePostMutationMirrorReconciliation } from "../mirrorReconciliationService.js";
import { upsertOperationStageProgress } from "../operationStageProgressService.js";
import { guardedEditHistoryUpdate } from "../operationTransitionGuards.js";
import { enqueueBulkEditVerification } from "../../queues/adapters/bulkEditVerificationQueueAdapter.js";

const VERIFY_MODE = "FULL";
const VERIFY_PAGE_SIZE = 500;
const VERIFICATION_TIMEOUT_MS =
  Math.max(1, Number.parseInt(process.env.VERIFICATION_TIMEOUT_MINUTES || "30", 10)) * 60 * 1000;
const NEXT_PAGE_DELAY_MS = Number.parseInt(
  process.env.BULK_EDIT_VERIFY_NEXT_PAGE_DELAY_MS || "1000",
  10,
);

function toNodeId(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  return value.startsWith("gid://") ? value : null;
}

function valuesEquivalent(current, wanted) {
  if (current === null || current === undefined || wanted === null || wanted === undefined) {
    return current === wanted;
  }
  if (typeof current === "boolean" || typeof wanted === "boolean") {
    return current === wanted;
  }
  const currentNumber = Number(current);
  const wantedNumber = Number(wanted);
  if (Number.isFinite(currentNumber) && Number.isFinite(wantedNumber)) {
    return currentNumber === wantedNumber;
  }
  return String(current) === String(wanted);
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

const VERIFY_VARIANT_INVENTORY_QUERY = `#graphql
  query VerifyVariantInventory($id: ID!, $first: Int!) {
    productVariant(id: $id) {
      id
      inventoryItem {
        id
        inventoryLevels(first: $first) {
          nodes {
            location {
              id
            }
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
        }
      }
    }
  }
`;

const VERIFY_OWNER_METAFIELD_QUERY = `#graphql
  query VerifyOwnerMetafield($id: ID!, $namespace: String!, $key: String!) {
    node(id: $id) {
      __typename
      id
      ... on Product {
        metafield(namespace: $namespace, key: $key) {
          id
          namespace
          key
          type
        }
      }
      ... on ProductVariant {
        metafield(namespace: $namespace, key: $key) {
          id
          namespace
          key
          type
        }
      }
    }
  }
`;

function buildShopifyAdminClient(shop, session) {
  if (!session?.accessToken || session.shop !== shop) {
    throw new Error("Shop session not available for verification");
  }
  return new shopify.api.clients.Graphql({ session });
}

async function fetchShopifyNodesByIds(shop, ids = [], session) {
  const client = buildShopifyAdminClient(shop, session);
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

async function fetchInventoryLevelsByTupleFromShopify({
  shop,
  inventoryRequests = new Map(),
  session,
}) {
  const client = buildShopifyAdminClient(shop, session);
  const map = new Map();
  for (const [variantId, requiredLocationIds] of inventoryRequests.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const response = await client.query({
      data: {
        query: VERIFY_VARIANT_INVENTORY_QUERY,
        variables: { id: variantId, first: 250 },
      },
    });
    const levels = response?.body?.data?.productVariant?.inventoryItem?.inventoryLevels?.nodes || [];
    for (const level of levels) {
      const locationId = String(level?.location?.id || "").trim();
      if (!locationId || !requiredLocationIds.has(locationId)) continue;
      const quantities = Array.isArray(level?.quantities) ? level.quantities : [];
      const available = quantities.find((quantity) => quantity?.name === "available")?.quantity ?? null;
      map.set(`${variantId}::${locationId}`, {
        available,
      });
    }
  }
  return map;
}

async function fetchMetafieldsByTupleFromShopify({
  shop,
  metafieldRequests = [],
  session,
}) {
  const client = buildShopifyAdminClient(shop, session);
  const map = new Map();
  const unique = new Map();
  for (const request of metafieldRequests) {
    const ownerId = String(request?.ownerId || "").trim();
    const namespace = String(request?.namespace || "").trim();
    const key = String(request?.key || "").trim();
    const type = String(request?.type || "").trim();
    if (!ownerId || !namespace || !key || !type) continue;
    unique.set(`${ownerId}::${namespace}::${key}::${type}`, {
      ownerId,
      namespace,
      key,
      type,
    });
  }

  for (const request of unique.values()) {
    // eslint-disable-next-line no-await-in-loop
    const response = await client.query({
      data: {
        query: VERIFY_OWNER_METAFIELD_QUERY,
        variables: {
          id: request.ownerId,
          namespace: request.namespace,
          key: request.key,
        },
      },
    });
    const node = response?.body?.data?.node || null;
    const metafield = node?.metafield || null;
    if (!metafield?.type) continue;
    map.set(
      `${request.ownerId}::${request.namespace}::${request.key}::${request.type}`,
      {
        ownerId: request.ownerId,
        namespace: request.namespace,
        key: request.key,
        type: String(metafield.type || ""),
      },
    );
  }

  return map;
}

async function markVerificationFailures({ client = db, shop, failedRows = [], chunkSize = 500 }) {
  let updatedCount = 0;
  for (let i = 0; i < failedRows.length; i += chunkSize) {
    const batch = failedRows.slice(i, i + chunkSize);
    const ids = batch.map((item) => String(item.id));
    const caseClauses = batch
      .map((item, index) => `WHEN id = $${index + 2} THEN $${index + 2 + batch.length}`)
      .join(" ");
    const params = [
      shop,
      ...ids,
      ...batch.map((item) => String(item.message || "")),
    ];
    // eslint-disable-next-line no-await-in-loop
    const updated = await client.$executeRawUnsafe(
      `
      UPDATE "ChangeRecord"
      SET
        "status" = 'VERIFICATION_FAILED'::"ChangeStatus",
        "failureCode" = 'VERIFICATION_MISMATCH',
        "failureMessage" = CASE ${caseClauses} ELSE "failureMessage" END
      WHERE "shop" = $1
        AND "status" = 'SUCCESS'::"ChangeStatus"
        AND "id" IN (${ids.map((_, index) => `$${index + 2}`).join(", ")})
      `,
      ...params,
    );
    updatedCount += Number(updated || 0);
  }
  return updatedCount;
}

function readExpectedFromAfterValues(afterValues = {}) {
  const productFieldChanges = Array.isArray(afterValues?.productFieldChanges)
    ? afterValues.productFieldChanges
    : [];
  const variantFieldChanges = Array.isArray(afterValues?.variantFieldChanges)
    ? afterValues.variantFieldChanges
    : [];
  const inventoryLevelChanges = Array.isArray(afterValues?.inventoryLevelChanges)
    ? afterValues.inventoryLevelChanges
    : [];
  const metafieldChanges = Array.isArray(afterValues?.metafieldChanges)
    ? afterValues.metafieldChanges
    : [];
  return {
    productFieldChanges,
    variantFieldChanges,
    inventoryLevelChanges,
    metafieldChanges,
  };
}

function normalizeInventoryTuple(change = {}, row = {}) {
  const tupleVariantId = String(change?.variantId ?? row?.variantId ?? "").trim();
  const tupleLocationId = String(change?.locationId ?? "").trim();
  return {
    variantId: tupleVariantId,
    locationId: tupleLocationId,
  };
}

function normalizeMetafieldTuple(change = {}, row = {}) {
  const tupleOwnerId = String(
    change?.ownerId ?? change?.variantId ?? change?.productId ?? row?.variantId ?? row?.productId ?? "",
  ).trim();
  const tupleNamespace = String(change?.namespace ?? "").trim();
  const tupleKey = String(change?.key ?? "").trim();
  const tupleType = String(change?.type ?? change?.valueType ?? "").trim();
  return {
    ownerId: tupleOwnerId,
    namespace: tupleNamespace,
    key: tupleKey,
    type: tupleType,
  };
}

function compareSimpleExpected({
  row,
  product,
  variantsById,
  expected,
  inventoryLevelsByTuple = new Map(),
  metafieldsByTuple = new Map(),
}) {
  const mismatches = [];
  for (const item of expected.productFieldChanges) {
    const field = item?.field;
    if (!field) continue;
    const current = product?.[field] ?? null;
    const wanted = item?.newValue ?? null;
    if (!valuesEquivalent(current, wanted)) {
      mismatches.push({ target: "product", field, expected: wanted, actual: current });
    }
  }

  for (const item of expected.variantFieldChanges) {
    const field = item?.field;
    const variantId = String(item?.variantId || "").trim();
    if (!field || !variantId) continue;
    if (row?.variantId && String(row.variantId) !== variantId) {
      mismatches.push({
        target: "variant",
        variantId,
        field: "tuple",
        expected: { rowVariantId: String(row.variantId), changeVariantId: variantId },
        actual: "variant_tuple_mismatch",
      });
      continue;
    }
    const variant = variantsById.get(variantId) || variantsById.get(String(variantId));
    const current = variant?.[field] ?? null;
    const wanted = item?.newValue ?? null;
    if (!valuesEquivalent(current, wanted)) {
      mismatches.push({ target: "variant", variantId, field, expected: wanted, actual: current });
    }
  }

  for (const item of expected.inventoryLevelChanges || []) {
    const { variantId, locationId } = normalizeInventoryTuple(item, row);
    if (!variantId || !locationId) {
      mismatches.push({
        target: "inventory",
        field: "tuple",
        expected: { variantId, locationId },
        actual: null,
      });
      continue;
    }
    const tupleKey = `${variantId}::${locationId}`;
    const current = inventoryLevelsByTuple.get(tupleKey) || null;
    if (!current) {
      mismatches.push({
        target: "inventory",
        field: "tuple",
        expected: { variantId, locationId },
        actual: null,
      });
      continue;
    }
    const wantedAvailable = item?.available;
    if (wantedAvailable !== undefined && wantedAvailable !== null) {
      const currentAvailable = current?.available ?? null;
      if (!valuesEquivalent(currentAvailable, wantedAvailable)) {
        mismatches.push({
          target: "inventory",
          field: "available",
          expected: wantedAvailable,
          actual: currentAvailable,
          variantId,
          locationId,
        });
      }
    }
  }

  for (const item of expected.metafieldChanges || []) {
    const { ownerId, namespace, key, type } = normalizeMetafieldTuple(item, row);
    if (!ownerId || !namespace || !key || !type) {
      mismatches.push({
        target: "metafield",
        field: "tuple",
        expected: { ownerId, namespace, key, type },
        actual: null,
      });
      continue;
    }
    const tupleKey = `${ownerId}::${namespace}::${key}::${type}`;
    const current = metafieldsByTuple.get(tupleKey) || null;
    if (!current) {
      mismatches.push({
        target: "metafield",
        field: "tuple",
        expected: { ownerId, namespace, key, type },
        actual: null,
      });
    }
  }

  return mismatches;
}

export class BulkEditVerificationService {
  constructor(session) {
    this.session = session;
  }

  async verifyBatch({ shop, historyId, executionId = null }) {
    if (!shop || !historyId) {
      throw new Error("VERIFICATION_REQUIRES_SHOP_AND_HISTORY_ID");
    }

    const history = await db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: {
        id: true,
        shop: true,
        executionState: true,
        executionIdentity: true,
        batch: true,
        verificationCursor: true,
        verifiedItems: true,
        failedVerifications: true,
        startedAt: true,
      },
    });

    if (!history) throw new Error("Edit history not found");
    if (executionId && history.executionIdentity && executionId !== history.executionIdentity) {
      throw new Error("STALE_EXECUTION_JOB");
    }

    if (
      history.executionState === OPERATION_LIFECYCLE_STATES.VERIFYING
      && history.startedAt
      && Date.now() - new Date(history.startedAt).getTime() > VERIFICATION_TIMEOUT_MS
    ) {
      const timedOut = await guardedEditHistoryUpdate({
        id: historyId,
        shop,
        expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.VERIFYING],
        data: {
          status: "failed",
          statusNormalized: normalizeEditHistoryStatus("failed"),
          executionState: OPERATION_LIFECYCLE_STATES.VERIFICATION_TIMEOUT,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.VERIFICATION_TIMEOUT,
          ),
          completedAt: new Date(),
          error: {
            code: "VERIFICATION_TIMEOUT",
            message: `Verification exceeded ${VERIFICATION_TIMEOUT_MS}ms`,
          },
        },
      });
      if (timedOut) {
        await upsertOperationStageProgress({
          shop,
          operationType: "BULK_EDIT",
          operationId: historyId,
          executionId: executionId || history.executionIdentity || null,
          stageKey: "VERIFICATION",
          stageStatus: "FAILED",
          detail: {
            reason: "VERIFICATION_TIMEOUT",
            timeoutMs: VERIFICATION_TIMEOUT_MS,
          },
        });
      }
      return { historyId, timedOut: true };
    }

    await upsertOperationStageProgress({
      shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: executionId || history.executionIdentity || null,
      stageKey: "VERIFICATION",
      stageStatus: "RUNNING",
      detail: {
        mode: VERIFY_MODE,
        verificationCursor: Number(history.verificationCursor || 0),
      },
    });

    const batchId =
      history.batch?.submittedBatchId
      || history.batch?.shopifyBulkOperation?.batchId
      || history.batch?.currentBatchId
      || null;

    const verificationCursor = Math.max(0, Number(history.verificationCursor || 0));
    // Keep the offset stable as rows transition away from SUCCESS. Already-terminal
    // rows may be replayed after a crash, but are never re-fetched from Shopify.
    const page = await db.changeRecord.findMany({
      where: {
        editHistoryId: historyId,
        shop,
        status: { in: ["SUCCESS", "VERIFIED", "VERIFICATION_FAILED"] },
      },
      orderBy: { id: "asc" },
      skip: verificationCursor,
      take: VERIFY_PAGE_SIZE,
      select: {
        id: true,
        targetIdentity: true,
        productId: true,
        variantId: true,
        afterValues: true,
        status: true,
      },
    });
    const verifyRows = page.filter(
      (row) => String(row.status || "").toUpperCase() === "SUCCESS",
    );

    const productIds = [...new Set(verifyRows.map((row) => row.productId).filter(Boolean))];
    const variantIds = [...new Set(verifyRows.map((row) => row.variantId).filter(Boolean))];

    const nodes = await fetchShopifyNodesByIds(
      shop,
      [...productIds, ...variantIds],
      this.session,
    );
    const productsById = new Map();
    const variantsById = new Map();
    for (const node of nodes.values()) {
      if (node?.__typename === "Product") {
        productsById.set(node.id, node);
      } else if (node?.__typename === "ProductVariant") {
        variantsById.set(node.id, node);
      }
    }

    const inventoryRequests = new Map();
    const metafieldRequestMap = new Map();
    for (const row of verifyRows) {
      const expected = readExpectedFromAfterValues(row.afterValues || {});

      for (const change of expected.inventoryLevelChanges) {
        const { variantId, locationId } = normalizeInventoryTuple(change, row);
        if (!variantId || !locationId) continue;
        if (!inventoryRequests.has(variantId)) inventoryRequests.set(variantId, new Set());
        inventoryRequests.get(variantId).add(locationId);
      }
      for (const change of expected.metafieldChanges) {
        const { ownerId, namespace, key, type } = normalizeMetafieldTuple(change, row);
        if (!ownerId || !namespace || !key || !type) continue;
        metafieldRequestMap.set(`${ownerId}::${namespace}::${key}::${type}`, {
          ownerId,
          namespace,
          key,
          type,
        });
      }
    }

    const inventoryLevelsByTuple = await fetchInventoryLevelsByTupleFromShopify({
      shop,
      inventoryRequests,
      session: this.session,
    });

    const metafieldsByTuple = await fetchMetafieldsByTupleFromShopify({
      shop,
      metafieldRequests: [...metafieldRequestMap.values()],
      session: this.session,
    });

    let verified = 0;
    let failed = 0;
    const verifiedIds = [];
    const failedRows = [];
    for (const row of verifyRows) {
      const product = productsById.get(row.productId);
      const expected = readExpectedFromAfterValues(row.afterValues || {});
      const mismatches = compareSimpleExpected({
        row,
        product,
        variantsById,
        expected,
        inventoryLevelsByTuple,
        metafieldsByTuple,
      });

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

    const nextCursor = verificationCursor + page.length;
    await db.$transaction(async (tx) => {
      if (verifiedIds.length > 0) {
        const updatedVerified = await tx.changeRecord.updateMany({
          where: {
            shop,
            id: { in: verifiedIds },
            status: "SUCCESS",
          },
          data: {
            status: "VERIFIED",
            failureCode: null,
            failureMessage: null,
          },
        });
        verified = Number(updatedVerified.count || 0);
      }
      failed = await markVerificationFailures({ client: tx, shop, failedRows });
      const updated = await tx.editHistory.updateMany({
        where: {
          id: historyId,
          shop,
          executionState: OPERATION_LIFECYCLE_STATES.VERIFYING,
          verificationCursor,
        },
        data: {
          verificationCursor: nextCursor,
          verifiedItems: { increment: verified },
          failedVerifications: { increment: failed },
        },
      });
      if (updated.count !== 1) {
        throw new Error("VERIFICATION_CURSOR_ADVANCE_CONFLICT");
      }
    });

    const [progress, appliedItems] = await Promise.all([
      db.editHistory.findFirst({
        where: { id: historyId, shop },
        select: {
          verificationCursor: true,
          verifiedItems: true,
          failedVerifications: true,
          batch: true,
        },
      }),
      db.changeRecord.count({
        where: {
          editHistoryId: historyId,
          shop,
          status: { in: ["SUCCESS", "VERIFIED", "VERIFICATION_FAILED"] },
        },
      }),
    ]);
    if (!progress) throw new Error("EDIT_HISTORY_NOT_FOUND_AFTER_VERIFICATION_PAGE");

    const verifiedItems = Number(progress.verifiedItems || 0);
    const failedVerifications = Number(progress.failedVerifications || 0);
    const fullCoverageAchieved =
      verifiedItems + failedVerifications === Number(appliedItems || 0);
    const hasRemainingPage = page.length === VERIFY_PAGE_SIZE;

    if (fullCoverageAchieved) {
      const historyUpdate = await guardedEditHistoryUpdate({
        id: historyId,
        shop,
        expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.VERIFYING],
        data: {
          status: "completed",
          statusNormalized: normalizeEditHistoryStatus("completed"),
          executionState: OPERATION_LIFECYCLE_STATES.COMPLETED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.COMPLETED,
          ),
          completedAt: new Date(),
          batch: {
            ...(progress.batch && typeof progress.batch === "object" ? progress.batch : {}),
            verification: {
              mode: VERIFY_MODE,
              fullCoverageAchieved: true,
              verifiedAt: new Date().toISOString(),
              verifiedCount: verifiedItems,
              verificationFailedCount: failedVerifications,
              verificationTargetCount: appliedItems,
              verificationCursor: Number(progress.verificationCursor || 0),
              lastSubmittedBatchId: batchId,
            },
          },
        },
      });
      if (!historyUpdate) {
        throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_VERIFICATION_RESULT");
      }

      await schedulePostMutationMirrorReconciliation({
        shop,
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        mirrorBatchId: progress.batch?.previewFingerprint?.mirrorBatchId || null,
        source: "BULK_EDIT_VERIFICATION",
        verificationStatus: failedVerifications > 0 ? "FAILED" : "SUCCESS",
      });
    } else {
      await enqueueBulkEditVerification(
        {
          historyId,
          shop,
          executionId: executionId || history.executionIdentity || null,
          source: "bulk_edit_verification_next_page",
        },
        {
          delay: NEXT_PAGE_DELAY_MS,
          jobId: `bulk-edit-verify:${shop}:${historyId}:${executionId || history.executionIdentity || "default"}:cursor:${nextCursor}`,
        },
      );
    }

    await upsertOperationStageProgress({
      shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: executionId || history.executionIdentity || null,
      stageKey: "VERIFICATION",
      stageStatus: fullCoverageAchieved ? "COMPLETED" : "RUNNING",
      counterA: verifiedItems,
      counterB: failedVerifications,
      counterC: appliedItems,
      detail: {
        mode: VERIFY_MODE,
        fullCoverageAchieved,
        verificationCursor: Number(progress.verificationCursor || 0),
        pageSize: page.length,
        pageVerified: verified,
        pageFailed: failed,
        hasRemainingPage,
        inventoryRequestCount: inventoryRequests.size,
        metafieldRequestCount: metafieldRequestMap.size,
        verificationTargetCount: appliedItems,
      },
      completed: fullCoverageAchieved,
    });

    return {
      historyId,
      shop,
      mode: VERIFY_MODE,
      fullCoverageAchieved,
      verificationCursor: Number(progress.verificationCursor || 0),
      verified: verifiedItems,
      verificationFailed: failedVerifications,
      appliedItems,
      nextPageEnqueued: !fullCoverageAchieved,
    };
  }
}
