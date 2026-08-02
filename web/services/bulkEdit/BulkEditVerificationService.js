import { db } from "../../repositories/repositoryDb.js";
import shopify from "../../shopify.js";
import { getSession } from "../../utils/sessionHandler.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import { upsertOperationStageProgress } from "../operationStageProgressService.js";
import { guardedEditHistoryUpdate } from "../operationTransitionGuards.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { reconcileVerifiedShopifyStateIntoActiveMirror } from "./BulkEditMirrorApplyService.js";
import { refreshTargetSnapshotSetCounters } from "../../repositories/targetSnapshotSetRepository.js";

const VERIFY_MODES = Object.freeze({
  NONE: "NONE",
  SAMPLE_ONLY: "SAMPLE_ONLY",
  SAMPLE_PLUS_FAILURES: "SAMPLE_PLUS_FAILURES",
  FULL_FOR_SMALL_BATCH: "FULL_FOR_SMALL_BATCH",
  FULL: "FULL",
});

const SUPPORTED_PRODUCT_VERIFY_FIELDS = new Set([
  "title",
  "status",
  "vendor",
  "productType",
  "handle",
  "description",
  "descriptionHtml",
  "tags",
  "seoTitle",
  "seoDescription",
]);

const SUPPORTED_VARIANT_VERIFY_FIELDS = new Set([
  "sku",
  "barcode",
  "price",
  "compareAtPrice",
  "inventoryQuantity",
  "taxable",
]);

const SHOPIFY_QUERY_RETRY_ATTEMPTS = Number.parseInt(
  process.env.BULK_EDIT_VERIFY_SHOPIFY_QUERY_RETRIES || "3",
  10,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeMessage(error) {
  return String(error?.message || error || "Unknown error").slice(0, 1000);
}

function assertNoShopifyGraphqlErrors(response) {
  const errors = response?.body?.errors || response?.errors;

  if (Array.isArray(errors) && errors.length > 0) {
    const message = errors[0]?.message || "SHOPIFY_GRAPHQL_ERROR";
    const error = new Error(`SHOPIFY_GRAPHQL_ERROR:${message}`);

    const lower = String(message).toLowerCase();
    error.retryable =
      lower.includes("throttled") ||
      lower.includes("timeout") ||
      lower.includes("internal") ||
      lower.includes("temporarily unavailable");

    throw error;
  }
}

async function shopifyQueryWithRetry(client, data, attempts = SHOPIFY_QUERY_RETRY_ATTEMPTS) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await client.query({ data });
      assertNoShopifyGraphqlErrors(response);
      return response;
    } catch (error) {
      lastError = error;

      if (!error?.retryable || attempt >= attempts) {
        throw error;
      }

      await sleep(500 * attempt * attempt);
    }
  }

  throw lastError;
}

function includesAnyToken(value, tokens = []) {
  const normalized = String(value || "").toLowerCase();
  return tokens.some((token) =>
    normalized.includes(String(token || "").toLowerCase()),
  );
}

function requiresFullVerification(history) {
  const targetGranularity = String(
    history?.batch?.targetGranularity || "",
  ).toUpperCase();

  if (targetGranularity === "VARIANT") return true;

  const rules = Array.isArray(history?.rules) ? history.rules : [];

  return rules.some((rule) =>
    includesAnyToken(rule?.field, ["inventory", "metafield", "variant"]),
  );
}

function isDeterministicHighRiskVerification(history) {
  return requiresFullVerification(history);
}

function pickVerificationMode(history) {
  if (requiresFullVerification(history)) return VERIFY_MODES.FULL;

  const configured = String(
    history?.batch?.verificationMode || "",
  ).toUpperCase();

  if (Object.values(VERIFY_MODES).includes(configured)) return configured;

  const count = Number(
    history?.batch?.currentBatchTargetCount ||
      history?.targetSnapshotCount ||
      0,
  );

  const destructive =
    Array.isArray(history?.rules) &&
    history.rules.some(
      (rule) => String(rule?.field || "") === "deleteProducts",
    );

  const risk = String(
    history?.batch?.blastRadiusAssessment?.riskLevel || "",
  ).toUpperCase();

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
        descriptionHtml
        tags
        seo {
          title
          description
        }
        updatedAt
        variants(first: 100) {
          nodes {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            inventoryQuantity
            taxable
            selectedOptions { name value }
          }
        }
      }
      ... on ProductVariant {
        id
        sku
        barcode
        price
        compareAtPrice
        inventoryQuantity
        taxable
        title
        selectedOptions { name value }
        product { id }
      }
    }
  }
`;

const VERIFY_VARIANT_INVENTORY_QUERY = `#graphql
  query VerifyVariantInventory($id: ID!, $first: Int!, $after: String) {
    productVariant(id: $id) {
      id
      inventoryItem {
        id
        inventoryLevels(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
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
          value
        }
      }
      ... on ProductVariant {
        metafield(namespace: $namespace, key: $key) {
          id
          namespace
          key
          type
          value
        }
      }
    }
  }
`;

async function buildShopifyAdminClient(shop) {
  const session = await getSession(shop);

  if (!session?.shop || session.shop !== shop) {
    const error = new Error("Shop session not available for verification");
    error.nonRetryable = true;
    throw error;
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
    const response = await shopifyQueryWithRetry(client, {
      query: VERIFY_NODES_QUERY,
      variables: { ids: chunk },
    });

    const nodes = response?.body?.data?.nodes || response?.data?.nodes || [];

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
    let after = null;
    let hasNextPage = true;
    let guard = 0;

    while (hasNextPage) {
      guard += 1;

      if (guard > 100) {
        const error = new Error("VERIFY_INVENTORY_PAGINATION_GUARD_EXCEEDED");
        error.retryable = true;
        throw error;
      }

      // eslint-disable-next-line no-await-in-loop
      const response = await shopifyQueryWithRetry(client, {
        query: VERIFY_VARIANT_INVENTORY_QUERY,
        variables: {
          id: variantId,
          first: 250,
          after,
        },
      });

      const levelsConnection =
        response?.body?.data?.productVariant?.inventoryItem?.inventoryLevels ||
        response?.data?.productVariant?.inventoryItem?.inventoryLevels ||
        null;

      const levels = levelsConnection?.nodes || [];

      for (const level of levels) {
        const locationId = String(level?.location?.id || "").trim();
        if (!locationId || !requiredLocationIds.has(locationId)) continue;

        const quantities = Array.isArray(level?.quantities)
          ? level.quantities
          : [];

        const available =
          quantities.find((quantity) => quantity?.name === "available")
            ?.quantity ?? null;

        map.set(`${variantId}::${locationId}`, {
          available,
        });
      }

      hasNextPage = Boolean(levelsConnection?.pageInfo?.hasNextPage);
      after = levelsConnection?.pageInfo?.endCursor || null;

      const foundAll = [...requiredLocationIds].every((locationId) =>
        map.has(`${variantId}::${locationId}`),
      );

      if (foundAll) break;
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
    const response = await shopifyQueryWithRetry(client, {
      query: VERIFY_OWNER_METAFIELD_QUERY,
      variables: {
        id: request.ownerId,
        namespace: request.namespace,
        key: request.key,
      },
    });

    const node = response?.body?.data?.node || response?.data?.node || null;
    const metafield = node?.metafield || null;

    if (!metafield?.type) continue;

    map.set(
      `${request.ownerId}::${request.namespace}::${request.key}::${request.type}`,
      {
        ownerId: request.ownerId,
        namespace: request.namespace,
        key: request.key,
        type: String(metafield.type || ""),
        value: String(metafield.value ?? ""),
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
    ? afterValues.variantFieldChanges.flatMap((group) => {
        if (Array.isArray(group?.changes)) {
          return group.changes.map((change) => ({
            ...change,
            variantId: change?.variantId || group?.variantId || null,
          }));
        }
        return [group];
      })
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

function readExpectedFromRow(row = {}) {
  const afterValues = row?.afterValues && typeof row.afterValues === "object"
    ? row.afterValues
    : {};
  return readExpectedFromAfterValues({
    ...afterValues,
    productFieldChanges: Array.isArray(afterValues.productFieldChanges)
      ? afterValues.productFieldChanges
      : row.productFieldChanges,
    variantFieldChanges: Array.isArray(afterValues.variantFieldChanges)
      ? afterValues.variantFieldChanges
      : row.variantFieldChanges,
  });
}

function readActualProductField(product, field) {
  if (field === "description") return product?.descriptionHtml ?? null;
  if (field === "seoTitle") return product?.seo?.title ?? null;
  if (field === "seoDescription") return product?.seo?.description ?? null;
  if (field === "tags") return Array.isArray(product?.tags) ? product.tags.join(", ") : product?.tags ?? null;
  return product?.[field] ?? null;
}

function normalizeInventoryTuple(change = {}, row = {}) {
  return {
    variantId: String(change?.variantId ?? row?.variantId ?? "").trim(),
    locationId: String(change?.locationId ?? "").trim(),
  };
}

function normalizeMetafieldTuple(change = {}, row = {}) {
  return {
    ownerId: String(
      change?.ownerId ??
        change?.variantId ??
        change?.productId ??
        row?.variantId ??
        row?.productId ??
        "",
    ).trim(),
    namespace: String(change?.namespace ?? "").trim(),
    key: String(change?.key ?? "").trim(),
    type: String(change?.type ?? change?.valueType ?? "").trim(),
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

    if (!SUPPORTED_PRODUCT_VERIFY_FIELDS.has(field)) {
      mismatches.push({
        target: "product",
        field,
        expected: item?.newValue,
        actual: "UNSUPPORTED_VERIFICATION_FIELD",
      });
      continue;
    }

    const current = readActualProductField(product, field);
    const wanted = item?.newValue ?? null;

    if (String(current) !== String(wanted)) {
      mismatches.push({
        target: "product",
        field,
        expected: wanted,
        actual: current,
      });
    }
  }

  for (const item of expected.variantFieldChanges) {
    const field = item?.field;
    const variantId = String(item?.variantId || "").trim();

    if (!field || !variantId) continue;

    if (!SUPPORTED_VARIANT_VERIFY_FIELDS.has(field)) {
      mismatches.push({
        target: "variant",
        variantId,
        field,
        expected: item?.newValue,
        actual: "UNSUPPORTED_VERIFICATION_FIELD",
      });
      continue;
    }

    if (row?.variantId && String(row.variantId) !== variantId) {
      mismatches.push({
        target: "variant",
        variantId,
        field: "tuple",
        expected: {
          rowVariantId: String(row.variantId),
          changeVariantId: variantId,
        },
        actual: "variant_tuple_mismatch",
      });
      continue;
    }

    const variant = variantsById.get(variantId);
    const current = variant?.[field] ?? null;
    const wanted = item?.newValue ?? null;

    if (String(current) !== String(wanted)) {
      mismatches.push({
        target: "variant",
        variantId,
        field,
        expected: wanted,
        actual: current,
      });
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
      continue;
    }

    if (String(current.type || "") !== String(type || "")) {
      mismatches.push({
        target: "metafield",
        field: "type",
        expected: type,
        actual: current.type,
        ownerId,
        namespace,
        key,
      });
      continue;
    }

    const wanted = item?.newValue ?? item?.value ?? null;

    if (wanted !== null && wanted !== undefined) {
      if (String(current.value ?? "") !== String(wanted ?? "")) {
        mismatches.push({
          target: "metafield",
          field: "value",
          expected: wanted,
          actual: current.value,
          ownerId,
          namespace,
          key,
        });
      }
    }
  }

  return mismatches;
}

export class BulkEditVerificationService {
  async verifyBatch({ shop, historyId, executionId = null }) {
    const history = await db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: {
        id: true,
        shop: true,
        executionIdentity: true,
        rules: true,
        isSpreadsheetEdit: true,
        batch: true,
        targetSnapshotCount: true,
        snapshotSetId: true,
      },
    });

    if (!history) throw new Error("Edit history not found");

    if (
      executionId &&
      history.executionIdentity &&
      executionId !== history.executionIdentity
    ) {
      const error = new Error("STALE_EXECUTION_JOB");
      error.nonRetryable = true;
      throw error;
    }

    if (history.batch?.verification?.verifiedAt) {
      return {
        historyId,
        shop,
        skipped: true,
        reason: "already_verified",
      };
    }

    const mode = pickVerificationMode(history);
    const deterministicFullRequired = isDeterministicHighRiskVerification(history);

    await upsertOperationStageProgress({
      shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: executionId || history.executionIdentity || null,
      workflowStageKey: "VERIFICATION",
      stageStatus: mode === VERIFY_MODES.NONE ? "SKIPPED" : "RUNNING",
      detail: { mode },
      completed: mode === VERIFY_MODES.NONE,
    });

    if (mode === VERIFY_MODES.NONE) {
      const updated = await guardedEditHistoryUpdate({
        id: historyId,
        shop,
        expectedExecutionStates: [
          OPERATION_LIFECYCLE_STATES.VERIFYING,
          OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
          OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
        ],
        expectedStateVersion: history?.stateVersion ?? 0,
        data: {
          status: "completed",
          statusNormalized: normalizeEditHistoryStatus("completed"),
          executionState: OPERATION_LIFECYCLE_STATES.COMPLETED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.COMPLETED,
          ),
          completedAt: new Date(),
          batch: {
            ...(history.batch && typeof history.batch === "object"
              ? history.batch
              : {}),
            verification: {
              mode,
              skipped: true,
              verifiedAt: new Date().toISOString(),
            },
          },
        },
      });

      if (!updated || !updated.success) {
        throw new Error("EDIT_HISTORY_UPDATE_FAILED_VERIFY_NONE_COMPLETE");
      }

      return {
        historyId,
        shop,
        mode,
        skipped: true,
        completed: true,
      };
    }

    const batchId =
      history.batch?.submittedBatchId ||
      history.batch?.shopifyBulkOperation?.batchId ||
      history.batch?.currentBatchId ||
      null;

    const rows = await db.changeRecord.findMany({
      where: {
        editHistoryId: historyId,
        shop,
        ...(history.isSpreadsheetEdit !== true && batchId ? { batchId } : {}),
      },
      select: {
        id: true,
        targetIdentity: true,
        fieldPath: true,
        productId: true,
        variantId: true,
        afterValues: true,
        productFieldChanges: true,
        variantFieldChanges: true,
        status: true,
      },
    });

    const successes = rows.filter(
      (row) => String(row.status || "").toUpperCase() === "SUCCESS",
    );

    const failures = rows.filter(
      (row) => String(row.status || "").toUpperCase() === "FAILED",
    );

    let verifyRows = [];
    const seed = `${historyId}:${batchId || "none"}`;

    if (
      deterministicFullRequired ||
      mode === VERIFY_MODES.FULL ||
      mode === VERIFY_MODES.FULL_FOR_SMALL_BATCH
    ) {
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

    const productIds = [
      ...new Set(verifyRows.map((row) => row.productId).filter(Boolean)),
    ];

    const variantIds = [
      ...new Set(verifyRows.map((row) => row.variantId).filter(Boolean)),
    ];

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
      const expected = readExpectedFromRow(row);

      for (const change of expected.inventoryLevelChanges) {
        const { variantId, locationId } = normalizeInventoryTuple(change, row);

        if (!variantId || !locationId) continue;

        if (!inventoryRequests.has(variantId)) {
          inventoryRequests.set(variantId, new Set());
        }

        inventoryRequests.get(variantId).add(locationId);
      }

      for (const change of expected.metafieldChanges) {
        const { ownerId, namespace, key, type } = normalizeMetafieldTuple(
          change,
          row,
        );

        if (!ownerId || !namespace || !key || !type) continue;

        metafieldRequests.push({
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
    });

    const metafieldsByTuple = await fetchMetafieldsByTupleFromShopify({
      shop,
      metafieldRequests,
    });

    const verificationTargetCount = successes.length;
    let verified = 0;
    let failed = 0;
    const verifiedIds = [];
    const verifiedTargetFields = [];
    const failedRows = [];

    const snapshotSetId =
      String(
        history.snapshotSetId || history.batch?.targetSnapshotRef?.snapshotSetId || "",
      ).trim() || null;
    const verifyTargetFields = verifyRows
      .map((row) => ({
        targetKey: String(row.targetIdentity || "").trim(),
        fieldPath: String(row.fieldPath || "").trim(),
      }))
      .filter((row) => row.targetKey && row.fieldPath);

    if (snapshotSetId && verifyTargetFields.length > 0) {
      await db.targetSnapshotItem.updateMany({
        where: {
          shop,
          snapshotSetId,
          OR: verifyTargetFields,
          executionStatus: "SUCCEEDED",
        },
        data: { verificationStatus: "PENDING" },
      });
    }

    for (const row of verifyRows) {
      const product = productsById.get(row.productId);
      const expected = readExpectedFromRow(row);

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
        verifiedTargetFields.push({
          targetKey: row.targetIdentity,
          fieldPath: row.fieldPath,
        });
      } else {
        failed += 1;
        failedRows.push({
          id: row.id,
          targetIdentity: row.targetIdentity,
          fieldPath: row.fieldPath,
          message: JSON.stringify(mismatches.slice(0, 20)).slice(0, 2000),
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
        batch.map((item) =>
          db.changeRecord.updateMany({
            where: { id: item.id, shop },
            data: {
              status: "VERIFICATION_FAILED",
              failureCode: "VERIFICATION_MISMATCH",
              failureMessage: item.message,
            },
          }),
        ),
      );
    }

    if (snapshotSetId) {
      for (let i = 0; i < verifiedTargetFields.length; i += chunkSize) {
        const targetFieldChunk = verifiedTargetFields.slice(i, i + chunkSize);
        // eslint-disable-next-line no-await-in-loop
        await db.targetSnapshotItem.updateMany({
          where: { shop, snapshotSetId, OR: targetFieldChunk },
          data: { verificationStatus: "SUCCEEDED", verifiedAt: new Date() },
        });
      }

      for (let i = 0; i < failedRows.length; i += chunkSize) {
        const targetFieldChunk = failedRows
          .slice(i, i + chunkSize)
          .map((row) => ({
            targetKey: String(row.targetIdentity || "").trim(),
            fieldPath: String(row.fieldPath || "").trim(),
          }))
          .filter((row) => row.targetKey && row.fieldPath);
        if (targetFieldChunk.length === 0) continue;
        // eslint-disable-next-line no-await-in-loop
        await db.targetSnapshotItem.updateMany({
          where: { shop, snapshotSetId, OR: targetFieldChunk },
          data: { verificationStatus: "FAILED", verifiedAt: new Date() },
        });
      }

      await refreshTargetSnapshotSetCounters({ shop, snapshotSetId, db });
    }

    const fullCoverageAchieved =
      verificationTargetCount === 0
        ? failures.length === 0
        : verifyRows.length === verificationTargetCount;

    const completionBlockedByCoverage =
      deterministicFullRequired && !fullCoverageAchieved;

    const movedToMirrorUpdating = await guardedEditHistoryUpdate({
      id: historyId,
      shop,
      expectedExecutionStates: [
        OPERATION_LIFECYCLE_STATES.VERIFYING,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
        OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      ],
      expectedStateVersion: history?.stateVersion ?? 0,
      data: {
        executionState: OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
        ),
      },
    });

    if (!movedToMirrorUpdating || !movedToMirrorUpdating.success) {
      throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_MIRROR_UPDATING");
    }

    const latest = await db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: {
        batch: true,
        executionState: true,
        stateVersion: true,
      },
    });

    if (latest?.batch?.verification?.verifiedAt) {
      return {
        historyId,
        shop,
        mode,
        skipped: true,
        reason: "already_verified_after_race",
      };
    }

    const totalFailed = failed + failures.length;

    const mirrorReconciliation = await reconcileVerifiedShopifyStateIntoActiveMirror({
      shop,
      productsById,
      variantsById,
    });

    const finalState =
      totalFailed > 0 || completionBlockedByCoverage
        ? OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED
        : OPERATION_LIFECYCLE_STATES.COMPLETED;

    const finalStatus =
      totalFailed > 0 || completionBlockedByCoverage
        ? "partial"
        : "completed";

    const historyUpdate = await guardedEditHistoryUpdate({
      id: historyId,
      shop,
      expectedExecutionStates: [
        OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
        OPERATION_LIFECYCLE_STATES.VERIFYING,
      ],
      expectedStateVersion: latest?.stateVersion ?? movedToMirrorUpdating.newVersion ?? (history?.stateVersion ? history.stateVersion + 1 : 0),
      data: {
        status: finalStatus,
        statusNormalized: normalizeEditHistoryStatus(finalStatus),
        executionState: finalState,
        executionStateNormalized: normalizeEditHistoryExecutionState(finalState),
        completedAt: new Date(),
        batch: {
          ...(latest?.batch && typeof latest.batch === "object"
            ? latest.batch
            : history.batch && typeof history.batch === "object"
              ? history.batch
              : {}),
          verification: {
            mode,
            deterministicFullRequired,
            fullCoverageAchieved,
            verifiedAt: new Date().toISOString(),
            verifiedCount: verified,
            verificationFailedCount: failed,
            shopifyFailedCount: failures.length,
            totalFailedCount: totalFailed,
            sampledCount: verifyRows.length,
            verificationTargetCount,
            completionBlockedByCoverage,
            mirrorReconciliation,
          },
        },
      },
    });

    if (!historyUpdate || !historyUpdate.success) {
      throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_VERIFICATION_RESULT");
    }

    await clearKeyCaches(`${shop}:historyChanges:${historyId}:`).catch(() => {});

    await upsertOperationStageProgress({
      shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: executionId || history.executionIdentity || null,
      workflowStageKey: "VERIFICATION",
      stageStatus:
        totalFailed > 0 || completionBlockedByCoverage
          ? "PARTIAL_FAILED"
          : "COMPLETED",
      succeededItemCount: verified,
      failedItemCount: totalFailed,
      observedItemCount: verifyRows.length,
      detail: {
        mode,
        deterministicFullRequired,
        fullCoverageAchieved,
        verificationTargetCount,
        shopifyFailedCount: failures.length,
        verificationFailedCount: failed,
        totalFailedCount: totalFailed,
        completionBlockedByCoverage,
        mirrorReconciliation,
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
      shopifyFailed: failures.length,
      totalFailed,
      sampledCount: verifyRows.length,
      mirrorReconciliation,
    };
  }
}
