import { db } from "../../repositories/repositoryDb.js";
import shopify from "../../shopify.js";
import { getSession } from "../../utils/sessionHandler.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import { schedulePostMutationMirrorReconciliation } from "../mirrorReconciliationService.js";
import { upsertOperationStageProgress } from "../operationStageProgressService.js";
import { guardedEditHistoryUpdate } from "../operationTransitionGuards.js";

const VERIFY_MODES = Object.freeze({
  NONE: "NONE",
  SAMPLE_ONLY: "SAMPLE_ONLY",
  SAMPLE_PLUS_FAILURES: "SAMPLE_PLUS_FAILURES",
  FULL_FOR_SMALL_BATCH: "FULL_FOR_SMALL_BATCH",
  FULL: "FULL",
});

const VERIFY_PAGE_SIZE = Number.parseInt(process.env.BULK_EDIT_VERIFY_PAGE_SIZE || "500", 10);
const MAX_VERIFICATION_ROWS_PER_RUN = Number.parseInt(
  process.env.BULK_EDIT_MAX_VERIFICATION_ROWS_PER_RUN || "1000",
  10,
);
const SAMPLE_RATIO = Number.parseFloat(process.env.BULK_EDIT_VERIFY_SAMPLE_RATIO || "0.1");
const SAMPLE_LIMIT_CAP = Number.parseInt(process.env.BULK_EDIT_VERIFY_SAMPLE_LIMIT_CAP || "1000", 10);
const PROGRESS_PAGE_INTERVAL = Number.parseInt(
  process.env.BULK_EDIT_VERIFY_PROGRESS_PAGE_INTERVAL || "10",
  10,
);
const MAX_INVENTORY_VARIANTS_PER_RUN = Number.parseInt(
  process.env.BULK_EDIT_VERIFY_MAX_INVENTORY_VARIANTS || "100",
  10,
);
const MAX_METAFIELD_REQUESTS_PER_RUN = Number.parseInt(
  process.env.BULK_EDIT_VERIFY_MAX_METAFIELD_REQUESTS || "100",
  10,
);

function includesAnyToken(value, tokens = []) {
  const normalized = String(value || "").toLowerCase();
  return tokens.some((token) => normalized.includes(String(token || "").toLowerCase()));
}

function requiresFullVerification(history) {
  const targetGranularity = String(history?.batch?.targetGranularity || "").toUpperCase();
  if (targetGranularity === "VARIANT") return true;
  const rules = Array.isArray(history?.rules) ? history.rules : [];
  return rules.some((rule) => includesAnyToken(rule?.field, ["inventory", "metafield", "variant"]));
}

function pickVerificationMode(history) {
  const configured = String(history?.batch?.verificationMode || "").toUpperCase();
  if (Object.values(VERIFY_MODES).includes(configured)) return configured;
  if (requiresFullVerification(history)) return VERIFY_MODES.FULL;

  const count = Number(history?.batch?.currentBatchTargetCount || history?.targetSnapshotCount || 0);
  const destructive = Array.isArray(history?.rules)
    && history.rules.some((rule) => String(rule?.field || "") === "deleteProducts");
  const risk = String(history?.batch?.blastRadiusAssessment?.riskLevel || "").toUpperCase();

  if (destructive || risk === "CRITICAL") return VERIFY_MODES.FULL;
  if (count > 0 && count <= 100) return VERIFY_MODES.FULL_FOR_SMALL_BATCH;
  return VERIFY_MODES.SAMPLE_PLUS_FAILURES;
}

function resolveSampleLimit(history) {
  const targetCount = Number(history?.targetSnapshotCount || history?.batch?.currentBatchTargetCount || 0);
  const ratio = Number.isFinite(SAMPLE_RATIO) && SAMPLE_RATIO > 0 ? SAMPLE_RATIO : 0.1;
  const cap = Number.isFinite(SAMPLE_LIMIT_CAP) && SAMPLE_LIMIT_CAP > 0 ? SAMPLE_LIMIT_CAP : 1000;
  return Math.max(1, Math.min(cap, Math.ceil(targetCount * ratio)));
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

function pushDeterministicSample(sampleRows, row, limit, seed) {
  if (limit <= 0) return sampleRows;
  const scored = {
    row,
    score: stableScore(seed, row.targetIdentity || row.id),
  };
  sampleRows.push(scored);
  sampleRows.sort((a, b) => a.score - b.score);
  if (sampleRows.length > limit) sampleRows.length = limit;
  return sampleRows;
}

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

async function buildShopifyAdminClient(shop) {
  const session = await getSession(shop);
  if (!session?.shop || session.shop !== shop) {
    throw new Error("Shop session not available for verification");
  }
  return new shopify.api.clients.Graphql({ session });
}

async function fetchShopifyNodesByIds(shop, ids = []) {
  const client = await buildShopifyAdminClient(shop);
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
}) {
  const client = await buildShopifyAdminClient(shop);
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
}) {
  const client = await buildShopifyAdminClient(shop);
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

async function markVerificationFailures({ shop, failedRows = [], chunkSize = 500 }) {
  for (let i = 0; i < failedRows.length; i += chunkSize) {
    const batch = failedRows.slice(i, i + chunkSize);
    const ids = batch.map((item) => String(item.id));
    const caseClauses = batch
      .map((item, index) => `WHEN id = $${index + 2}::uuid THEN $${index + 2 + batch.length}`)
      .join(" ");
    const params = [
      shop,
      ...ids,
      ...batch.map((item) => String(item.message || "")),
    ];
    // eslint-disable-next-line no-await-in-loop
    await db.$executeRawUnsafe(
      `
      UPDATE "ChangeRecord"
      SET
        "status" = 'VERIFICATION_FAILED',
        "failureCode" = 'VERIFICATION_MISMATCH',
        "failureMessage" = CASE ${caseClauses} ELSE "failureMessage" END
      WHERE "shop" = $1
        AND "id" IN (${ids.map((_, index) => `$${index + 2}::uuid`).join(", ")})
      `,
      ...params,
    );
  }
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
  async verifyBatch({ shop, historyId, executionId = null }) {
    if (!shop || !historyId) {
      throw new Error("VERIFICATION_REQUIRES_SHOP_AND_HISTORY_ID");
    }

    const history = await db.editHistory.findFirst({
      where: { id: historyId, shop },
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
    if (!batchId) {
      const error = new Error("VERIFICATION_REQUIRES_BATCH_ID");
      error.code = "VERIFICATION_REQUIRES_BATCH_ID";
      throw error;
    }

    const highRiskVerification = requiresFullVerification(history);
    const seed = `${historyId}:${batchId}`;
    const sampleLimit = mode === VERIFY_MODES.FULL || mode === VERIFY_MODES.FULL_FOR_SMALL_BATCH
      ? Math.max(1, MAX_VERIFICATION_ROWS_PER_RUN)
      : resolveSampleLimit(history);
    const sampleRows = [];
    const failures = [];
    let successesLength = 0;
    let cursorId = null;
    let pageCount = 0;

    while (true) {
      const page = await db.changeRecord.findMany({
        where: {
          editHistoryId: historyId,
          shop,
          batchId,
          ...(cursorId ? { id: { gt: cursorId } } : {}),
        },
        orderBy: { id: "asc" },
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
      if (!page.length) break;
      pageCount += 1;

      for (const row of page) {
        const status = String(row.status || "").toUpperCase();
        if (status === "SUCCESS") {
          successesLength += 1;
          pushDeterministicSample(sampleRows, row, sampleLimit, seed);
        } else if (status === "FAILED") {
          pushDeterministicSample(failures, row, sampleLimit, `${seed}:failed`);
        }
      }

      cursorId = page[page.length - 1].id;
      if (pageCount % Math.max(1, PROGRESS_PAGE_INTERVAL) === 0 || page.length < VERIFY_PAGE_SIZE) {
        // eslint-disable-next-line no-await-in-loop
        await upsertOperationStageProgress({
          shop,
          operationType: "BULK_EDIT",
          operationId: historyId,
          executionId: executionId || history.executionIdentity || null,
          stageKey: "VERIFICATION",
          stageStatus: "SCANNING_CHANGE_RECORDS",
          counterA: successesLength,
          counterB: failures.length,
          detail: { mode, batchId, cursorId, pageCount },
        });
      }
      if (page.length < VERIFY_PAGE_SIZE) break;
    }

    const verifyRows = mode === VERIFY_MODES.SAMPLE_PLUS_FAILURES
      ? [
          ...sampleRows.map((item) => item.row),
          ...failures.map((item) => item.row),
        ]
      : sampleRows.map((item) => item.row);

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

    const inventoryRequests = new Map();
    const metafieldRequestMap = new Map();
    const budgetSkippedRowIds = new Set();
    for (const row of verifyRows) {
      const expected = readExpectedFromAfterValues(row.afterValues || {});
      const rowInventoryRequests = new Map();
      const rowMetafieldRequests = new Map();

      for (const change of expected.inventoryLevelChanges) {
        const { variantId, locationId } = normalizeInventoryTuple(change, row);
        if (!variantId || !locationId) continue;
        if (!rowInventoryRequests.has(variantId)) rowInventoryRequests.set(variantId, new Set());
        rowInventoryRequests.get(variantId).add(locationId);
      }
      for (const change of expected.metafieldChanges) {
        const { ownerId, namespace, key, type } = normalizeMetafieldTuple(change, row);
        if (!ownerId || !namespace || !key || !type) continue;
        rowMetafieldRequests.set(`${ownerId}::${namespace}::${key}::${type}`, {
          ownerId,
          namespace,
          key,
          type,
        });
      }

      const newInventoryVariantCount = [...rowInventoryRequests.keys()]
        .filter((variantId) => !inventoryRequests.has(variantId))
        .length;
      const newMetafieldRequestCount = [...rowMetafieldRequests.keys()]
        .filter((requestKey) => !metafieldRequestMap.has(requestKey))
        .length;
      if (
        inventoryRequests.size + newInventoryVariantCount > Math.max(0, MAX_INVENTORY_VARIANTS_PER_RUN)
        || metafieldRequestMap.size + newMetafieldRequestCount > Math.max(0, MAX_METAFIELD_REQUESTS_PER_RUN)
      ) {
        budgetSkippedRowIds.add(row.id);
        continue;
      }

      for (const [variantId, locationIds] of rowInventoryRequests.entries()) {
        if (!inventoryRequests.has(variantId)) inventoryRequests.set(variantId, new Set());
        for (const locationId of locationIds) {
          inventoryRequests.get(variantId).add(locationId);
        }
      }
      for (const [requestKey, request] of rowMetafieldRequests.entries()) {
        metafieldRequestMap.set(requestKey, request);
      }
    }

    const inventoryLevelsByTuple = await fetchInventoryLevelsByTupleFromShopify({
      shop,
      inventoryRequests,
    });

    const metafieldsByTuple = await fetchMetafieldsByTupleFromShopify({
      shop,
      metafieldRequests: [...metafieldRequestMap.values()],
    });

    const verificationTargetCount = successesLength;
    let verified = 0;
    let failed = 0;
    const verifiedIds = [];
    const failedRows = [];
    for (const row of verifyRows) {
      if (budgetSkippedRowIds.has(row.id)) {
        continue;
      }
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

    const chunkSize = 500;
    for (let i = 0; i < verifiedIds.length; i += chunkSize) {
      const idChunk = verifiedIds.slice(i, i + chunkSize);
      // eslint-disable-next-line no-await-in-loop
      await db.changeRecord.updateMany({
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
    await markVerificationFailures({ shop, failedRows, chunkSize });

    const evaluatedCount = verified + failed;
    const fullCoverageAchieved = evaluatedCount === verificationTargetCount;
    const completionBlockedByCoverage = highRiskVerification && !fullCoverageAchieved;

    const verificationStatus = failed > 0 ? "FAILED" : "SUCCESS";
    const finalState = failed > 0 || completionBlockedByCoverage
      ? OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED
      : OPERATION_LIFECYCLE_STATES.COMPLETED;
    const finalStatus = failed > 0 || completionBlockedByCoverage ? "partial" : "completed";

    const historyUpdate = await guardedEditHistoryUpdate({
      id: historyId,
      shop,
      expectedExecutionStates: [
        OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
        OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
        OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
        OPERATION_LIFECYCLE_STATES.VERIFYING,
      ],
      extraWhere: {
        batch: {
          path: ["verification", "verifiedAt"],
          equals: null,
        },
      },
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
            highRiskVerification,
            fullCoverageAchieved,
            verifiedAt: new Date().toISOString(),
            verifiedCount: verified,
            verificationFailedCount: failed,
            sampledCount: verifyRows.length,
            evaluatedCount,
            budgetSkippedCount: budgetSkippedRowIds.size,
            verificationTargetCount,
            completionBlockedByCoverage,
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
      mirrorBatchId: history.batch?.previewFingerprint?.mirrorBatchId || null,
      source: "BULK_EDIT_VERIFICATION",
      verificationStatus,
    });

    await upsertOperationStageProgress({
      shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: executionId || history.executionIdentity || null,
      stageKey: "VERIFICATION",
      stageStatus: failed > 0 || completionBlockedByCoverage ? "PARTIAL_FAILED" : "COMPLETED",
      counterA: verified,
      counterB: failed,
      counterC: verifyRows.length,
      detail: {
        mode,
        highRiskVerification,
        fullCoverageAchieved,
        evaluatedCount,
        budgetSkippedCount: budgetSkippedRowIds.size,
        inventoryRequestCount: inventoryRequests.size,
        metafieldRequestCount: metafieldRequestMap.size,
        verificationTargetCount,
        completionBlockedByCoverage,
      },
      completed: true,
    });

    return {
      historyId,
      shop,
      mode,
      highRiskVerification,
      fullCoverageAchieved,
      verified,
      verificationFailed: failed,
      sampledCount: verifyRows.length,
      evaluatedCount,
      budgetSkippedCount: budgetSkippedRowIds.size,
    };
  }
}
