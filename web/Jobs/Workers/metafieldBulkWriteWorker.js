import { Worker } from "bullmq";
import shopify from "../../shopify.js";
import { connection as redisConnection } from "../../config/redis.js";
import {
  listPendingLedgerRows,
  markRowWriting,
  markRowWritten,
  markRowError,
} from "../../db/bulkEditChanges.js";
import { markDeadLetterNotified, moveToDeadLetter } from "../../db/deadLetterChanges.js";
import { addShopSyncJob } from "../Queues/shopSyncJob.js";

const QUEUE_NAME = process.env.METAFIELD_BULK_WRITE_QUEUE || "metafield-bulk-write";
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
    attemptCount: Number(row.attempt_count || 0),
    shopifyOwnerId: String(row.shopify_owner_id),
    shopifyMetafieldId:
      row.shopify_metafield_id == null ? null : String(row.shopify_metafield_id),
  };
}

async function notifyMerchantTerminalFailure(shop, row, errorCode) {
  console.error("[metafieldBulkWriteWorker] terminal row failure", {
    shop,
    changeId: row?.id,
    variantId: row?.variantId,
    namespace: row?.namespace,
    key: row?.key,
    errorCode,
  });
  await markDeadLetterNotified(String(row?.id || ""));
}

async function markRowErrorWithDeadLetter(row, errorCode, retryable) {
  await markRowError(row.id, errorCode, retryable);
  const nextAttempt = Number(row.attemptCount || 0) + 1;
  const terminal = !retryable || nextAttempt >= 3;
  if (!terminal) return;
  await moveToDeadLetter(row.id, errorCode);
  await notifyMerchantTerminalFailure(row.shop, row, errorCode);
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
  let staleDetected = false;
  for (let i = 0; i < candidates.length; i += 1) {
    const expected = candidates[i];
    const node = nodes[i];
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
  if (!row.compareDigest) {
    const error = new Error("MISSING_COMPARE_DIGEST");
    error.code = "MISSING_COMPARE_DIGEST";
    throw error;
  }
}

function parseErrorIndex(field) {
  const asArray = Array.isArray(field) ? field : [];
  for (const token of asArray) {
    const match = String(token || "").match(/^metafields\[(\d+)\]$/i);
    if (match) return Number.parseInt(match[1], 10);
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

async function callMetafieldsSet(client, rows) {
  const metafields = rows.map((row) => ({
    ownerId: row.shopifyOwnerId,
    namespace: row.namespace,
    key: row.key,
    type: row.type,
    value: row.newValue,
    compareDigest: row.compareDigest,
  }));

  const response = await client.query({
    data: {
      query: METAFIELDS_SET_MUTATION,
      variables: { metafields },
    },
  });

  const payload = response?.body?.data?.metafieldsSet;
  if (!payload) {
    const error = new Error("METAFIELDS_SET_EMPTY_RESPONSE");
    error.code = "METAFIELDS_SET_EMPTY_RESPONSE";
    throw error;
  }
  return payload;
}

/**
 * Dedicated metafield bulk write execution contract.
 * - source: bulk_edit_changes only
 * - compareDigest required per row
 * - chunk size 25
 * - STALE_OBJECT terminal, no retry
 *
 * @param {{ sessionId: string, shop: string }} input
 * @returns {Promise<{processed:number,written:number,errored:number}>}
 */
export async function runMetafieldBulkWrite({ sessionId, shop }) {
  const resolvedSessionId = String(sessionId || "").trim();
  const resolvedShop = String(shop || "").trim();
  if (!resolvedSessionId || !resolvedShop) {
    throw new Error("sessionId and shop are required");
  }

  const pendingRows = await listPendingLedgerRows(resolvedSessionId, resolvedShop);
  if (!pendingRows.length) {
    throw new Error("EXECUTION_SOURCE_INVALID");
  }

  const rows = pendingRows.map(normalizeRow);
  for (const row of rows) {
    assertMetafieldWriteInput(row);
  }

  const session = await loadOfflineSession(resolvedShop);
  await runDigestPreflight(session, rows);
  const client = new shopify.api.clients.Graphql({ session });

  let processed = 0;
  let written = 0;
  let errored = 0;

  for (const batch of chunk(rows, METAFIELDS_SET_BATCH_SIZE)) {
    for (const row of batch) {
      // eslint-disable-next-line no-await-in-loop
      await markRowWriting(row.id);
    }

    let payload;
    try {
      // eslint-disable-next-line no-await-in-loop
      payload = await callMetafieldsSet(client, batch);
    } catch (error) {
      for (const row of batch) {
        // eslint-disable-next-line no-await-in-loop
        await markRowErrorWithDeadLetter(
          row,
          error?.code || "METAFIELDS_SET_REQUEST_FAILED",
          true,
        );
        errored += 1;
        processed += 1;
      }
      continue;
    }

    const userErrors = Array.isArray(payload.userErrors) ? payload.userErrors : [];
    const perIndexErrors = buildErrorBuckets(userErrors, batch.length);
    const successLookup = buildSuccessLookup(payload.metafields);

    for (let idx = 0; idx < batch.length; idx += 1) {
      const row = batch[idx];
      const errors = perIndexErrors[idx];
      const tupleKey = `${row.shopifyOwnerId}::${row.namespace}::${row.key}`;
      const success = successLookup.get(tupleKey) || null;

      if (errors.length > 0) {
        const stale = errors.some((e) => String(e?.code || "").toUpperCase() === "STALE_OBJECT");
        const firstCode = String(errors[0]?.code || "SHOPIFY_USER_ERROR");
        // eslint-disable-next-line no-await-in-loop
        await markRowErrorWithDeadLetter(row, stale ? "STALE_OBJECT" : firstCode, stale ? false : true);
        errored += 1;
        processed += 1;
        continue;
      }

      if (!success) {
        // Ambiguous response row: treat as retryable error.
        // eslint-disable-next-line no-await-in-loop
        await markRowErrorWithDeadLetter(row, "METAFIELD_RESULT_MISSING", true);
        errored += 1;
        processed += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await markRowWritten(row.id, success.value, success.compareDigest);
      written += 1;
      processed += 1;
    }
  }

  return { processed, written, errored };
}

export const metafieldBulkWriteWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const sessionId = String(job?.data?.sessionId || "").trim();
    const shop = String(job?.data?.shop || "").trim();
    return runMetafieldBulkWrite({ sessionId, shop });
  },
  {
    connection: redisConnection,
    concurrency: Number.isFinite(WORKER_CONCURRENCY) ? WORKER_CONCURRENCY : 2,
  },
);

metafieldBulkWriteWorker.on("failed", (job, error) => {
  console.error("[metafieldBulkWriteWorker] failed", {
    jobId: job?.id,
    sessionId: job?.data?.sessionId,
    shop: job?.data?.shop,
    error: error?.message || String(error),
  });
});

export default metafieldBulkWriteWorker;
