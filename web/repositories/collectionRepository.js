// web/repositories/collectionRepository.js

import crypto from "crypto";
import { db } from "./repositoryDb.js";
import { normalizeShopDomain } from "../utils/shopDomainUtils.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_SEARCH_LENGTH = 100;
const MAX_CURSOR_LENGTH = 512;
const MAX_CURSOR_PAYLOAD_BYTES = 384;
const MAX_ID_LENGTH = 128;
const MAX_BATCH_ID_LENGTH = 128;

const COLLECTION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MIRROR_BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_LENGTH_BYTES = 32;

function buildRepositoryError(
  message,
  code = "VALIDATION_FAILED",
) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwRepositoryError(
  message,
  code = "VALIDATION_FAILED",
) {
  throw buildRepositoryError(message, code);
}

function assertShop(shopRaw) {
  const shop = normalizeShopDomain(shopRaw);

  if (!shop) {
    throwRepositoryError(
      "Invalid tenant context",
      "INVALID_TENANT_CONTEXT",
    );
  }

  return shop;
}

function enforceLimit(limitRaw) {
  if (limitRaw === undefined || limitRaw === null) {
    return DEFAULT_LIMIT;
  }

  const limit = Number(limitRaw);

  if (!Number.isInteger(limit) || limit < 1) {
    throwRepositoryError(
      "Invalid collection query limit",
    );
  }

  if (limit > MAX_LIMIT) {
    throwRepositoryError(
      `Collection query limit cannot exceed ${MAX_LIMIT}`,
    );
  }

  return limit;
}

function normalizeSearch(value) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value !== "string") {
    throwRepositoryError(
      "Collection search must be a string",
    );
  }

  const normalized = value.trim();

  if (normalized.length > MAX_SEARCH_LENGTH) {
    throwRepositoryError(
      "Collection search exceeds the maximum length",
    );
  }

  if (/[\u0000-\u001F\u007F]/.test(normalized)) {
    throwRepositoryError(
      "Collection search contains invalid characters",
    );
  }

  return normalized;
}

function normalizeRequiredIdentifier(
  value,
  {
    fieldName,
    maxLength,
    pattern,
  },
) {
  if (typeof value !== "string") {
    throwRepositoryError(
      `${fieldName} is invalid`,
    );
  }

  const normalized = value.trim();

  if (
    !normalized ||
    normalized.length > maxLength ||
    !pattern.test(normalized)
  ) {
    throwRepositoryError(
      `${fieldName} is invalid`,
    );
  }

  return normalized;
}

function validateCollectionId(value) {
  return normalizeRequiredIdentifier(value, {
    fieldName: "Collection ID",
    maxLength: MAX_ID_LENGTH,
    pattern: COLLECTION_ID_PATTERN,
  });
}

function validateMirrorBatchId(value) {
  return normalizeRequiredIdentifier(value, {
    fieldName: "Collection mirror batch ID",
    maxLength: MAX_BATCH_ID_LENGTH,
    pattern: MIRROR_BATCH_ID_PATTERN,
  });
}

function validateCursorTitle(value) {
  if (typeof value !== "string") {
    throwRepositoryError(
      "Cursor title is invalid",
    );
  }

  if (
    value.length > MAX_SEARCH_LENGTH * 4 ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throwRepositoryError(
      "Cursor title is invalid",
    );
  }

  return value;
}

function getCursorSecret() {
  const secret =
    process.env.COLLECTION_CURSOR_SECRET?.trim();

  if (!secret || secret.length < 32) {
    throwRepositoryError(
      "Collection cursor secret is not configured",
      "COLLECTION_CURSOR_CONFIGURATION_ERROR",
    );
  }

  return secret;
}

function computeTenantHash(shop) {
  return crypto
    .createHash("sha256")
    .update(shop, "utf8")
    .digest("hex")
    .slice(0, 24);
}

function computeSearchHash(search) {
  return crypto
    .createHash("sha256")
    .update(search.toLocaleLowerCase("en-US"), "utf8")
    .digest("hex")
    .slice(0, 24);
}

function signCursorPayload(encodedPayload) {
  return crypto
    .createHmac("sha256", getCursorSecret())
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

function signaturesMatch(actual, expected) {
  if (
    typeof actual !== "string" ||
    typeof expected !== "string" ||
    !BASE64URL_PATTERN.test(actual) ||
    !BASE64URL_PATTERN.test(expected)
  ) {
    return false;
  }

  const actualBuffer = Buffer.from(
    actual,
    "base64url",
  );

  const expectedBuffer = Buffer.from(
    expected,
    "base64url",
  );

  if (
    actualBuffer.length !== SIGNATURE_LENGTH_BYTES ||
    expectedBuffer.length !==
    SIGNATURE_LENGTH_BYTES ||
    actualBuffer.length !== expectedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    actualBuffer,
    expectedBuffer,
  );
}

function encodeCursor({
  shop,
  mirrorBatchId,
  searchHash,
  title,
  id,
}) {
  const payload = Object.freeze({
    version: 1,
    tenantHash: computeTenantHash(shop),
    mirrorBatchId:
      validateMirrorBatchId(mirrorBatchId),
    searchHash,
    title: validateCursorTitle(title ?? ""),
    id: validateCollectionId(id),
  });

  const payloadBuffer = Buffer.from(
    JSON.stringify(payload),
    "utf8",
  );

  if (
    payloadBuffer.byteLength >
    MAX_CURSOR_PAYLOAD_BYTES
  ) {
    throwRepositoryError(
      "Collection cursor payload is too large",
    );
  }

  const encodedPayload =
    payloadBuffer.toString("base64url");

  const signature =
    signCursorPayload(encodedPayload);

  const cursor = `${encodedPayload}.${signature}`;

  if (cursor.length > MAX_CURSOR_LENGTH) {
    throwRepositoryError(
      "Collection cursor exceeds the maximum length",
    );
  }

  return cursor;
}

function decodeCursor(
  cursorRaw,
  {
    shop,
    mirrorBatchId,
    searchHash,
  },
) {
  if (
    cursorRaw === undefined ||
    cursorRaw === null ||
    cursorRaw === ""
  ) {
    return null;
  }

  if (
    typeof cursorRaw !== "string" ||
    cursorRaw.length > MAX_CURSOR_LENGTH
  ) {
    throwRepositoryError(
      "Collection cursor is invalid",
    );
  }

  const parts = cursorRaw.split(".");

  if (
    parts.length !== 2 ||
    !BASE64URL_PATTERN.test(parts[0]) ||
    !BASE64URL_PATTERN.test(parts[1])
  ) {
    throwRepositoryError(
      "Collection cursor is invalid",
    );
  }

  const [encodedPayload, suppliedSignature] =
    parts;

  const expectedSignature =
    signCursorPayload(encodedPayload);

  if (
    !signaturesMatch(
      suppliedSignature,
      expectedSignature,
    )
  ) {
    throwRepositoryError(
      "Collection cursor signature is invalid",
    );
  }

  let payloadBuffer;

  try {
    payloadBuffer = Buffer.from(
      encodedPayload,
      "base64url",
    );
  } catch {
    throwRepositoryError(
      "Collection cursor is invalid",
    );
  }

  if (
    payloadBuffer.byteLength === 0 ||
    payloadBuffer.byteLength >
    MAX_CURSOR_PAYLOAD_BYTES
  ) {
    throwRepositoryError(
      "Collection cursor payload is invalid",
    );
  }

  let payload;

  try {
    payload = JSON.parse(
      payloadBuffer.toString("utf8"),
    );
  } catch {
    throwRepositoryError(
      "Collection cursor payload is invalid",
    );
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.version !== 1 ||
    payload.tenantHash !==
    computeTenantHash(shop) ||
    payload.mirrorBatchId !== mirrorBatchId ||
    payload.searchHash !== searchHash
  ) {
    throwRepositoryError(
      "Collection cursor does not match this query",
    );
  }

  return Object.freeze({
    title: validateCursorTitle(payload.title),
    id: validateCollectionId(payload.id),
  });
}

async function getCollectionMirrorContext(
  client,
  shop,
) {
  const store = await client.store.findUnique({
    where: {
      shopUrl: shop,
    },
    select: {
      currentCollectionMirrorBatchId: true,
    },
  });

  if (!store) {
    throwRepositoryError(
      "Store was not found",
      "STORE_NOT_FOUND",
    );
  }

  if (!store.currentCollectionMirrorBatchId) {
    return Object.freeze({
      mirrorBatchId: null,
      ready: false,
    });
  }

  return Object.freeze({
    mirrorBatchId: validateMirrorBatchId(
      store.currentCollectionMirrorBatchId,
    ),
    ready: true,
  });
}

function buildSearchCondition(search) {
  if (!search) {
    return null;
  }

  return {
    title: {
      contains: search,
      mode: "insensitive",
    },
  };
}

function buildCursorCondition(decodedCursor) {
  if (!decodedCursor) {
    return null;
  }

  return {
    OR: [
      {
        title: {
          gt: decodedCursor.title,
        },
      },
      {
        title: decodedCursor.title,
        id: {
          gt: decodedCursor.id,
        },
      },
    ],
  };
}

async function fetchCollectionsForBatch({
  client,
  shop,
  mirrorBatchId,
  search,
  cursor,
  limit,
}) {
  const searchHash = computeSearchHash(search);

  const decodedCursor = decodeCursor(cursor, {
    shop,
    mirrorBatchId,
    searchHash,
  });

  const conditions = [
    buildSearchCondition(search),
    buildCursorCondition(decodedCursor),
  ].filter(Boolean);

  const items = await client.collection.findMany({
    where: {
      shop,
      mirrorBatchId,
      ...(conditions.length > 0
        ? { AND: conditions }
        : {}),
    },
    take: limit + 1,
    orderBy: [
      {
        title: "asc",
      },
      {
        id: "asc",
      },
    ],
    select: {
      id: true,
      shopifyId: true,
      title: true,
      handle: true,
      updatedAt: true,
    },
  });

  const hasNextPage = items.length > limit;

  const collections = hasNextPage
    ? items.slice(0, limit)
    : items;

  const lastItem =
    collections[collections.length - 1];

  return Object.freeze({
    collections,
    nextCursor:
      hasNextPage && lastItem
        ? encodeCursor({
          shop,
          mirrorBatchId,
          searchHash,
          title: lastItem.title,
          id: lastItem.id,
        })
        : null,
    hasNextPage,
    limit,
    mirrorBatchId,
  });
}

async function countCollectionsForBatch({
  client,
  shop,
  mirrorBatchId,
  search,
}) {
  return client.collection.count({
    where: {
      shop,
      mirrorBatchId,
      ...(search
        ? {
          title: {
            contains: search,
            mode: "insensitive",
          },
        }
        : {}),
    },
  });
}

async function executeWithOptionalTransaction(
  tx,
  operation,
) {
  if (tx) {
    return operation(tx);
  }

  return db.$transaction(operation, {
    isolationLevel: "RepeatableRead",
  });
}

export async function getActiveCollectionMirrorBatchId(
  clientOrTx,
  shopRaw,
) {
  const client = clientOrTx || db;
  const shop = assertShop(shopRaw);

  const context =
    await getCollectionMirrorContext(
      client,
      shop,
    );

  return context.mirrorBatchId;
}

export async function fetchMirrorCollections({
  shop,
  search = "",
  cursor = null,
  limit = DEFAULT_LIMIT,
  tx = null,
}) {
  const safeShop = assertShop(shop);
  const safeSearch = normalizeSearch(search);
  const safeLimit = enforceLimit(limit);

  return executeWithOptionalTransaction(
    tx,
    async (client) => {
      const mirrorContext =
        await getCollectionMirrorContext(
          client,
          safeShop,
        );

      if (!mirrorContext.ready) {
        return Object.freeze({
          collections: [],
          nextCursor: null,
          hasNextPage: false,
          limit: safeLimit,
          mirrorBatchId: null,
        });
      }

      return fetchCollectionsForBatch({
        client,
        shop: safeShop,
        mirrorBatchId:
          mirrorContext.mirrorBatchId,
        search: safeSearch,
        cursor,
        limit: safeLimit,
      });
    },
  );
}

export async function countMirrorCollections({
  shop,
  search = "",
  mirrorBatchId = null,
  tx = null,
}) {
  const safeShop = assertShop(shop);
  const safeSearch = normalizeSearch(search);

  return executeWithOptionalTransaction(
    tx,
    async (client) => {
      let resolvedMirrorBatchId =
        mirrorBatchId;

      if (resolvedMirrorBatchId) {
        resolvedMirrorBatchId =
          validateMirrorBatchId(
            resolvedMirrorBatchId,
          );
      } else {
        const mirrorContext =
          await getCollectionMirrorContext(
            client,
            safeShop,
          );

        if (!mirrorContext.ready) {
          return 0;
        }

        resolvedMirrorBatchId =
          mirrorContext.mirrorBatchId;
      }

      return countCollectionsForBatch({
        client,
        shop: safeShop,
        mirrorBatchId:
          resolvedMirrorBatchId,
        search: safeSearch,
      });
    },
  );
}

export async function findCollectionByShopAndId({
  shop,
  id,
  tx = null,
}) {
  const safeShop = assertShop(shop);
  const safeId = validateCollectionId(id);

  return executeWithOptionalTransaction(
    tx,
    async (client) => {
      const mirrorContext =
        await getCollectionMirrorContext(
          client,
          safeShop,
        );

      if (!mirrorContext.ready) {
        return null;
      }

      return client.collection.findFirst({
        where: {
          shop: safeShop,
          mirrorBatchId:
            mirrorContext.mirrorBatchId,
          id: safeId,
        },
        select: {
          id: true,
          shopifyId: true,
          title: true,
          handle: true,
          updatedAt: true,
        },
      });
    },
  );
}

export async function fetchMirrorCollectionsPage({
  shop,
  search = "",
  cursor = null,
  limit = DEFAULT_LIMIT,
  includeTotal = false,
  tx = null,
}) {
  const safeShop = assertShop(shop);
  const safeSearch = normalizeSearch(search);
  const safeLimit = enforceLimit(limit);

  if (typeof includeTotal !== "boolean") {
    throwRepositoryError(
      "includeTotal must be a boolean",
    );
  }

  return executeWithOptionalTransaction(
    tx,
    async (client) => {
      const mirrorContext =
        await getCollectionMirrorContext(
          client,
          safeShop,
        );

      if (!mirrorContext.ready) {
        return Object.freeze({
          collections: [],
          nextCursor: null,
          hasNextPage: false,
          limit: safeLimit,
          mirrorBatchId: null,
          totalCount: includeTotal ? 0 : null,
        });
      }

      const listResult =
        await fetchCollectionsForBatch({
          client,
          shop: safeShop,
          mirrorBatchId:
            mirrorContext.mirrorBatchId,
          search: safeSearch,
          cursor,
          limit: safeLimit,
        });

      const totalCount = includeTotal
        ? await countCollectionsForBatch({
          client,
          shop: safeShop,
          mirrorBatchId:
            mirrorContext.mirrorBatchId,
          search: safeSearch,
        })
        : null;

      return Object.freeze({
        ...listResult,
        totalCount,
      });
    },
  );
}