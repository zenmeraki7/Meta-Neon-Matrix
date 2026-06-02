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

function isDeterministicHighRiskVerification(history) {
  return requiresFullVerification(history);
}

function pickVerificationMode(history) {
  if (requiresFullVerification(history)) return VERIFY_MODES.FULL;
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
    if (String(current) !== String(wanted)) {
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
    if (String(current) !== String(wanted)) {
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
      if (String(currentAvailable) !== String(wantedAvailable)) {
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
    const history = await db.editHistory.findUnique({
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
    const deterministicFullRequired = isDeterministicHighRiskVerification(history);
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

    const rows = await db.changeRecord.findMany({
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
    if (deterministicFullRequired || mode === VERIFY_MODES.FULL || mode === VERIFY_MODES.FULL_FOR_SMALL_BATCH) {
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

    const inventoryRequests = new Map();
    const metafieldRequests = [];
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
        metafieldRequests.push({ ownerId, namespace, key, type });
      }
    }

    const inventoryLevelsByTuple = await fetchInventoryLevelsByTupleFromShopify({
      shop,
      inventoryRequests,
    });

    const metafieldsByTuple = await fetchMetafieldsByTupleFromShopify({
      shop,
      metafieldRequests,
    });

    const verificationTargetCount = successes.length;
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
    for (let i = 0; i < failedRows.length; i += chunkSize) {
      const batch = failedRows.slice(i, i + chunkSize);
      // eslint-disable-next-line no-await-in-loop
      await db.$transaction(
        batch.map((item) => db.changeRecord.updateMany({
          where: { id: item.id, shop },
          data: {
            status: "VERIFICATION_FAILED",
            failureCode: "VERIFICATION_MISMATCH",
            failureMessage: item.message,
          },
        })),
      );
    }

    const fullCoverageAchieved = verifyRows.length === verificationTargetCount;
    const completionBlockedByCoverage = deterministicFullRequired && !fullCoverageAchieved;
    const movedToMirrorUpdating = await guardedEditHistoryUpdate({
      id: historyId,
      shop,
      expectedExecutionStates: [
        OPERATION_LIFECYCLE_STATES.VERIFYING,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
        OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      ],
      data: {
        executionState: OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
        ),
      },
    });
    if (!movedToMirrorUpdating) {
      throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_MIRROR_UPDATING");
    }

    const verificationStatus = failed > 0 ? "FAILED" : "SUCCESS";
    await schedulePostMutationMirrorReconciliation({
      shop,
      ownerType: "EDIT_HISTORY",
      ownerId: historyId,
      mirrorBatchId: history.batch?.previewFingerprint?.mirrorBatchId || null,
      source: "BULK_EDIT_VERIFICATION",
      verificationStatus,
    });

    const finalState = failed > 0 || completionBlockedByCoverage
      ? OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED
      : OPERATION_LIFECYCLE_STATES.COMPLETED;
    const finalStatus = failed > 0 || completionBlockedByCoverage ? "partial" : "completed";

    const historyUpdate = await guardedEditHistoryUpdate({
      id: historyId,
      shop,
      expectedExecutionStates: [
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
            deterministicFullRequired,
            fullCoverageAchieved,
            verifiedAt: new Date().toISOString(),
            verifiedCount: verified,
            verificationFailedCount: failed,
            sampledCount: verifyRows.length,
            verificationTargetCount,
            completionBlockedByCoverage,
          },
        },
      },
    });
    if (!historyUpdate) {
      throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_VERIFICATION_RESULT");
    }
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
        deterministicFullRequired,
        fullCoverageAchieved,
        verificationTargetCount,
        completionBlockedByCoverage,
      },
      completed: true,
    });

    return {
      historyId,
      shop,
      mode,
      deterministicFullRequired,
      fullCoverageAchieved,
      verified,
      verificationFailed: failed,
      sampledCount: verifyRows.length,
    };
  }
}

