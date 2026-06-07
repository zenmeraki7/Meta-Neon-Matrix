import { UnrecoverableError, Worker } from "bullmq";
import shopify from "../../shopify.js";
import { connection as redisConnection } from "../../config/redis.js";
import {
  countLedgerRows,
  listPendingLedgerRows,
  markRowsWriting,
  markRowsWritten,
  markRowsError,
  markRowsRetryable,
} from "../../db/bulkEditChanges.js";
import {
  markDeadLettersNotified,
  moveRowsToDeadLetter,
} from "../../db/deadLetterChanges.js";
import { addShopSyncJob } from "../Queues/shopSyncJob.js";
import logger from "../../utils/loggerUtils.js";
import { metafieldBulkWriteDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import { isRetryExhausted } from "../../utils/workerTelemetry.js";
import {
  getBudgetManager,
  isThrottleError,
} from "../../services/shopify/ShopifyBudgetManager.js";

const QUEUE_NAME = process.env.METAFIELD_BULK_WRITE_QUEUE || "metafield-bulk-write";
const DLQ_NAME = process.env.METAFIELD_BULK_WRITE_DLQ_QUEUE || "metafield-bulk-write-dlq";
const WORKER_CONCURRENCY = Number.parseInt(
  process.env.METAFIELD_BULK_WRITE_CONCURRENCY || "2",
  10,
);
const METAFIELDS_SET_BATCH_SIZE = 25;

const METAFIELDS_SET_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        namespace
        key
        value
        compareDigest
        owner {
          ... on ProductVariant { id }
          ... on Product { id }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const METAFIELD_DIGEST_PREFLIGHT_QUERY = `#graphql
  query MetafieldDigestPreflight($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metafield {
        id
        compareDigest
      }
    }
  }
`;

const METAFIELD_RECONCILIATION_QUERY = `#graphql
  query MetafieldReconciliation($ownerId: ID!, $namespace: String!, $key: String!) {
    node(id: $ownerId) {
      ... on ProductVariant {
        metafield(namespace: $namespace, key: $key) {
          value
          compareDigest
        }
      }
      ... on Product {
        metafield(namespace: $namespace, key: $key) {
          value
          compareDigest
        }
      }
    }
  }
`;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

function normalizeRow(row) {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    shop: String(row.shop_id),
    variantId: String(row.variant_id),
    namespace: String(row.namespace),
    key: String(row.key),
    type: String(row.type),
    oldValue: row.old_value == null ? null : String(row.old_value),
    newValue: row.new_value == null ? null : String(row.new_value),
    compareDigest: row.compare_digest == null ? null : String(row.compare_digest),
    status: String(row.status || "").toUpperCase(),
    attemptCount: Number(row.attempt_count || 0),
    shopifyOwnerId: String(row.shopify_owner_id),
    shopifyMetafieldId:
      row.shopify_metafield_id == null ? null : String(row.shopify_metafield_id),
  };
}

async function persistErrorResults(results, shop) {
  if (!results.length) return;
  await markRowsError(results, shop);
  const terminal = results.filter(
    (result) => !result.retryable || Number(result.attemptCount || 0) + 1 >= 3,
  );
  if (!terminal.length) return;

  await moveRowsToDeadLetter(terminal, shop);
  for (const result of terminal) {
    logger.error("Metafield bulk write terminal row failure", {
      worker: "metafieldBulkWriteWorker",
      shop,
      changeId: result.id,
      variantId: result.variantId,
      namespace: result.namespace,
      key: result.key,
      errorCode: result.errorCode,
    });
  }
  await markDeadLettersNotified(terminal.map((result) => result.id), shop);
}

async function triggerPreflightSync(shop) {
  await addShopSyncJob({
    shop,
    syncType: "product",
    reason: "metafield_preflight_stale",
  });
}

/**
 * Cheap drift detector before bulk write:
 * sample up to 10 dirty rows and compare compareDigest against Shopify.
 * If stale, trigger sync and fail fast before mass writes.
 *
 * @param {import("@shopify/shopify-api").Session} session
 * @param {Array<ReturnType<typeof normalizeRow>>} rows
 * @returns {Promise<void>}
 */
async function runDigestPreflight(session, rows) {
  const candidates = rows
    .filter((row) => row.shopifyMetafieldId && row.compareDigest)
    .slice(0, 10);
  if (!candidates.length) return;

  const client = new shopify.api.clients.Graphql({ session });
  const response = await client.query({
    data: {
      query: METAFIELD_DIGEST_PREFLIGHT_QUERY,
      variables: {
        ids: candidates.map((row) => row.shopifyMetafieldId),
      },
    },
  });

  const nodes = Array.isArray(response?.body?.data?.nodes) ? response.body.data.nodes : [];
  const nodeById = new Map(
    nodes
      .filter((node) => node?.id)
      .map((node) => [String(node.id), node]),
  );
  let staleDetected = false;
  for (const expected of candidates) {
    const node = nodeById.get(expected.shopifyMetafieldId);
    const compareDigest = node?.compareDigest == null ? null : String(node.compareDigest);
    if (!node?.id || compareDigest !== expected.compareDigest) {
      staleDetected = true;
      break;
    }
  }

  if (!staleDetected) return;

  await triggerPreflightSync(String(session.shop || ""));
  const error = new Error("PREFLIGHT_STALE");
  error.code = "PREFLIGHT_STALE";
  throw error;
}

/**
 * Ensures every row has compareDigest before touching Shopify.
 * @param {ReturnType<typeof normalizeRow>} row
 * @returns {void}
 */
export function assertMetafieldWriteInput(row) {
  const required = [
    ["compareDigest", "MISSING_COMPARE_DIGEST"],
    ["shopifyOwnerId", "MISSING_SHOPIFY_OWNER_ID"],
    ["namespace", "MISSING_NAMESPACE"],
    ["key", "MISSING_KEY"],
    ["type", "MISSING_TYPE"],
  ];
  for (const [field, code] of required) {
    if (!row[field]) {
      const error = new Error(code);
      error.code = code;
      error.nonRetryable = true;
      throw error;
    }
  }
  if (row.newValue == null) {
    const error = new Error("MISSING_NEW_VALUE");
    error.code = "MISSING_NEW_VALUE";
    error.nonRetryable = true;
    throw error;
  }
}

function parseErrorIndex(field) {
  const asArray = Array.isArray(field) ? field : [];
  for (let index = 0; index < asArray.length; index += 1) {
    const token = asArray[index];
    const match = String(token || "").match(/^metafields\[(\d+)\]$/i);
    if (match) return Number.parseInt(match[1], 10);
    if (
      String(token || "").toLowerCase() === "metafields"
      && /^\d+$/.test(String(asArray[index + 1] || ""))
    ) {
      return Number.parseInt(String(asArray[index + 1]), 10);
    }
  }
  return -1;
}

function buildErrorBuckets(userErrors, size) {
  const buckets = Array.from({ length: size }, () => []);
  for (const err of Array.isArray(userErrors) ? userErrors : []) {
    const idx = parseErrorIndex(err?.field);
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].push(err);
    }
  }
  return buckets;
}

function buildSuccessLookup(metafields = []) {
  const map = new Map();
  for (const mf of Array.isArray(metafields) ? metafields : []) {
    const ownerId = String(mf?.owner?.id || "").trim();
    const namespace = String(mf?.namespace || "").trim();
    const key = String(mf?.key || "").trim();
    if (!ownerId || !namespace || !key) continue;
    map.set(`${ownerId}::${namespace}::${key}`, {
      value: mf?.value == null ? null : String(mf.value),
      compareDigest: mf?.compareDigest == null ? null : String(mf.compareDigest),
    });
  }
  return map;
}

async function loadOfflineSession(shop) {
  const offlineId = shopify.api.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(offlineId);
  if (!session) {
    const error = new Error("OFFLINE_SESSION_NOT_FOUND");
    error.code = "OFFLINE_SESSION_NOT_FOUND";
    throw error;
  }
  return session;
}

async function callMetafieldsSet(client, rows, budget) {
  const metafields = rows.map((row) => ({
    ownerId: row.shopifyOwnerId,
    namespace: row.namespace,
    key: row.key,
    type: row.type,
    value: row.newValue,
    compareDigest: row.compareDigest,
  }));

  const response = await budget.executeWithBudget(50, () =>
    client.query({
      data: {
        query: METAFIELDS_SET_MUTATION,
        variables: { metafields },
      },
    }));

  const payload = response?.body?.data?.metafieldsSet;
  if (!payload) {
    const error = new Error("METAFIELDS_SET_EMPTY_RESPONSE");
    error.code = "METAFIELDS_SET_EMPTY_RESPONSE";
    throw error;
  }
  return payload;
}

function errorCodeOf(error, fallback = "SHOPIFY_REQUEST_FAILED") {
  return String(
    error?.code
      || error?.body?.errors?.[0]?.extensions?.code
      || error?.response?.body?.errors?.[0]?.extensions?.code
      || fallback,
  ).toUpperCase();
}

function isStaleObject(errorCode) {
  return String(errorCode || "").toUpperCase() === STALE_OBJECT_CODE;
}

function formatWriteResults(outcomes) {
  const successes = outcomes.filter((outcome) => outcome.status === "WRITTEN");
  const failures = outcomes.filter((outcome) => outcome.status !== "WRITTEN");
  return { outcomes, successes, failures };
}

/**
 * Applies one Shopify-sized metafield batch and returns one explicit outcome per row.
 *
 * @param {object} client
 * @param {Array<ReturnType<typeof normalizeRow>>} rows
 * @returns {Promise<{outcomes:Array<object>,successes:Array<object>,failures:Array<object>}>}
 */
export async function writeMetafields(client, rows, budget = null) {
  let payload;
  try {
    const resolvedBudget = budget || getBudgetManager(rows[0]?.shop);
    payload = await callMetafieldsSet(client, rows, resolvedBudget);
  } catch (error) {
    const throttled = isThrottleError(error);
    const errorCode = errorCodeOf(error, "METAFIELDS_SET_OUTCOME_UNKNOWN");
    return formatWriteResults(rows.map((row) => ({
      id: row.id,
      status: throttled ? "RETRYING" : "FAILED",
      error: throttled ? "THROTTLED" : errorCode,
    })));
  }

  const userErrors = Array.isArray(payload.userErrors) ? payload.userErrors : [];
  const perIndexErrors = buildErrorBuckets(userErrors, rows.length);
  const successLookup = buildSuccessLookup(payload.metafields);
  const outcomes = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    const errors = perIndexErrors[idx];
    const tupleKey = `${row.shopifyOwnerId}::${row.namespace}::${row.key}`;
    const success = successLookup.get(tupleKey) || null;

    if (errors.length > 0) {
      const errorCode = String(errors[0]?.code || "SHOPIFY_USER_ERROR").toUpperCase();
      outcomes.push({
        id: row.id,
        status: isStaleObject(errorCode) ? "FAILED" : "RETRYING",
        error: errorCode,
      });
      continue;
    }

    if (!success) {
      outcomes.push({
        id: row.id,
        status: "FAILED",
        error: "METAFIELD_RESULT_OUTCOME_UNKNOWN",
      });
      continue;
    }

    outcomes.push({
      id: row.id,
      status: "WRITTEN",
      confirmedValue: success.value,
      digest: success.compareDigest,
    });
  }

  return formatWriteResults(outcomes);
}

async function fetchCurrentMetafield(client, row) {
  const response = await client.query({
    data: {
      query: METAFIELD_RECONCILIATION_QUERY,
      variables: {
        ownerId: row.shopifyOwnerId,
        namespace: row.namespace,
        key: row.key,
      },
    },
  });
  const errors = Array.isArray(response?.body?.errors) ? response.body.errors : [];
  if (errors.length) {
    const error = new Error(errors[0]?.message || "METAFIELD_RECONCILIATION_FAILED");
    error.code = errors[0]?.extensions?.code || "METAFIELD_RECONCILIATION_FAILED";
    throw error;
  }
  return response?.body?.data?.node?.metafield || null;
}

/**
 * Resolves stale WRITING rows before they are eligible for another mutation.
 *
 * @param {object} client
 * @param {Array<ReturnType<typeof normalizeRow>>} rows
 * @returns {Promise<{retryRows:Array<object>,outcomes:Array<object>}>}
 */
export async function reconcileWritingRows(client, rows) {
  const retryRows = [];
  const outcomes = [];
  for (const row of rows) {
    if (row.status !== "WRITING") {
      retryRows.push(row);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const current = await fetchCurrentMetafield(client, row);
      if (String(current?.value ?? "") === String(row.newValue ?? "")) {
        outcomes.push({
          id: row.id,
          status: "WRITTEN",
          confirmedValue: current?.value == null ? null : String(current.value),
          digest: current?.compareDigest == null ? null : String(current.compareDigest),
        });
      } else {
        retryRows.push(row);
        outcomes.push({ id: row.id, status: "RETRYING" });
      }
    } catch (error) {
      const errorCode = errorCodeOf(error, "METAFIELD_RECONCILIATION_FAILED");
      outcomes.push({
        id: row.id,
        status: "FAILED",
        error: errorCode,
      });
    }
  }
  return { retryRows, outcomes };
}

/**
 * Dedicated metafield bulk write execution contract.
 * - source: bulk_edit_changes only
 * - compareDigest required per row
 * - chunk size 25
 * - stale compare-digest conflicts are terminal
 *
 * @param {{ sessionId: string, shop: string }} input
 * @returns {Promise<Array<{id:string,status:"WRITTEN"|"FAILED"|"RETRYING",error?:string}>>}
 */
async function runMetafieldBulkWrite({ sessionId, shop }) {
  const resolvedSessionId = String(sessionId || "").trim();
  const resolvedShop = String(shop || "").trim();
  if (!resolvedSessionId || !resolvedShop) {
    throw new Error("sessionId and shop are required");
  }

  const pendingRows = await listPendingLedgerRows(resolvedSessionId, resolvedShop);
  if (!pendingRows.length) {
    const totalRows = await countLedgerRows(resolvedSessionId, resolvedShop);
    if (totalRows === 0) {
      const error = new Error("EXECUTION_SOURCE_INVALID");
      error.nonRetryable = true;
      throw error;
    }
    return {
      outcomes: [],
      reason: "all_rows_already_processed",
    };
  }

  const rows = pendingRows.map(normalizeRow);
  for (const row of rows) {
    assertMetafieldWriteInput(row);
  }

  const session = await loadOfflineSession(resolvedShop);
  const client = new shopify.api.clients.Graphql({ session });
  const budget = getBudgetManager(resolvedShop);
  const allOutcomes = [];
  const { retryRows, outcomes: reconciliationOutcomes } = await reconcileWritingRows(client, rows);
  const reconciledWritten = reconciliationOutcomes.filter((outcome) => outcome.status === "WRITTEN");
  const reconciledFailed = reconciliationOutcomes.filter((outcome) => outcome.status === "FAILED");
  const reconciledRetrying = reconciliationOutcomes.filter((outcome) => outcome.status === "RETRYING");
  if (reconciledWritten.length) {
    await markRowsWritten(reconciledWritten, resolvedShop);
  }
  if (reconciledFailed.length) {
    await persistErrorResults(reconciledFailed.map((outcome) => ({
      id: outcome.id,
      errorCode: outcome.error,
      retryable: false,
    })), resolvedShop);
  }
  if (reconciledRetrying.length) {
    await markRowsError(reconciledRetrying.map((outcome) => ({
      id: outcome.id,
      errorCode: "RECONCILED_NOT_APPLIED",
      retryable: true,
    })), resolvedShop);
  }
  allOutcomes.push(...reconciliationOutcomes.filter((outcome) => outcome.status !== "RETRYING"));
  await runDigestPreflight(session, retryRows);

  for (const batch of chunk(retryRows, METAFIELDS_SET_BATCH_SIZE)) {
    // eslint-disable-next-line no-await-in-loop
    const claimedIds = await markRowsWriting(batch.map((row) => row.id), resolvedShop);
    const claimedIdSet = new Set(claimedIds);
    const claimedBatch = batch.filter((row) => claimedIdSet.has(row.id));
    const unclaimedBatch = batch.filter((row) => !claimedIdSet.has(row.id));
    allOutcomes.push(...unclaimedBatch.map((row) => ({
      id: row.id,
      status: "RETRYING",
      error: "ROW_CLAIMED_BY_ANOTHER_WORKER",
    })));
    if (!claimedBatch.length) {
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const { outcomes } = await writeMetafields(client, claimedBatch, budget);
    const writtenOutcomes = outcomes.filter((outcome) => outcome.status === "WRITTEN");
    const failedOutcomes = outcomes.filter((outcome) => outcome.status === "FAILED");
    const retryingOutcomes = outcomes.filter((outcome) => outcome.status === "RETRYING");
    const throttledOutcomes = retryingOutcomes.filter(
      (outcome) => outcome.error === "THROTTLED",
    );
    const otherRetryingOutcomes = retryingOutcomes.filter(
      (outcome) => outcome.error !== "THROTTLED",
    );

    if (writtenOutcomes.length) {
      // eslint-disable-next-line no-await-in-loop
      await markRowsWritten(writtenOutcomes, resolvedShop);
    }
    if (throttledOutcomes.length) {
      // eslint-disable-next-line no-await-in-loop
      await markRowsRetryable(
        throttledOutcomes.map((outcome) => outcome.id),
        resolvedShop,
      );
    }
    if (failedOutcomes.length || otherRetryingOutcomes.length) {
      // eslint-disable-next-line no-await-in-loop
      await persistErrorResults([
        ...failedOutcomes.map((outcome) => ({
          id: outcome.id,
          errorCode: outcome.error,
          retryable: false,
        })),
        ...otherRetryingOutcomes.map((outcome) => ({
          id: outcome.id,
          errorCode: outcome.error,
          retryable: true,
        })),
      ], resolvedShop);
    }
    allOutcomes.push(...outcomes);
  }

  return allOutcomes;
}

export const metafieldBulkWriteWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const sessionId = String(job?.data?.sessionId || "").trim();
    const shop = String(job?.data?.shop || "").trim();
    try {
      return await runMetafieldBulkWrite({ sessionId, shop });
    } catch (error) {
      if (error?.nonRetryable) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: Number.isFinite(WORKER_CONCURRENCY) ? WORKER_CONCURRENCY : 2,
    lockDuration: Number(process.env.METAFIELD_BULK_WRITE_LOCK_DURATION_MS || 600_000),
    stalledInterval: Number(process.env.METAFIELD_BULK_WRITE_STALLED_INTERVAL_MS || 60_000),
    maxStalledCount: Number(process.env.METAFIELD_BULK_WRITE_MAX_STALLED_COUNT || 1),
  },
);

metafieldBulkWriteWorker.on("completed", (job, result) => {
  logger.info("Metafield bulk write worker completed", {
    worker: "metafieldBulkWriteWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    sessionId: job?.data?.sessionId,
    shop: job?.data?.shop,
    result,
  });
});

metafieldBulkWriteWorker.on("failed", (job, error) => {
  logger.error("Metafield bulk write worker failed", {
    worker: "metafieldBulkWriteWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    sessionId: job?.data?.sessionId,
    shop: job?.data?.shop,
    attemptsMade: job?.attemptsMade,
    message: error?.message || String(error),
    stack: error?.stack,
  });
  if (isRetryExhausted(job) || error?.name === "UnrecoverableError") {
    void metafieldBulkWriteDlqQueue.add(
      DLQ_NAME,
      {
        originalJobId: job?.id,
        data: job?.data,
        failedReason: error?.message,
        stack: error?.stack,
        failedAt: new Date().toISOString(),
      },
      { jobId: `dlq:${QUEUE_NAME}:${job?.id}` },
    ).catch((dlqError) => {
      logger.error("Metafield bulk write DLQ enqueue failed", {
        worker: "metafieldBulkWriteWorker",
        jobId: job?.id,
        message: dlqError?.message,
      });
    });
  }
});

metafieldBulkWriteWorker.on("stalled", (jobId) => {
  logger.warn("Metafield bulk write worker stalled", {
    worker: "metafieldBulkWriteWorker",
    queue: QUEUE_NAME,
    jobId,
  });
});

metafieldBulkWriteWorker.on("error", (error) => {
  logger.error("Metafield bulk write worker runtime error", {
    worker: "metafieldBulkWriteWorker",
    queue: QUEUE_NAME,
    message: error?.message,
    stack: error?.stack,
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await metafieldBulkWriteWorker.close();
  } catch (error) {
    logger.error("Metafield bulk write worker shutdown failed", {
      worker: "metafieldBulkWriteWorker",
      signal,
      message: error?.message,
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

const STALE_OBJECT_CODE = "STALE_OBJECT";

export default metafieldBulkWriteWorker;
