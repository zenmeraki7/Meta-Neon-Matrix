// web/controllers/collectionController.js
import {
  toCollectionRefreshAcceptedDto,
  toCollectionResponseDto,
} from "../dtos/collectionDto.js";

const COLLECTION_LIST_KEYS = new Set(["search", "limit", "cursor"]);
const COLLECTION_OPTIONS_KEYS = new Set(["search", "limit", "cursor"]);
const LIVE_COLLECTION_KEYS = new Set(["search", "limit", "cursor"]);

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function validateCollectionQuery(rawQuery = {}, allowedKeys = COLLECTION_LIST_KEYS) {
  const unknownKeys = Object.keys(rawQuery || {}).filter(
    (key) => !allowedKeys.has(key),
  );

  if (unknownKeys.length > 0) {
    const error = new Error(`Invalid query keys: ${unknownKeys.join(",")}`);
    error.code = "VALIDATION_ERROR";
    throw error;
  }

  const search = normalizeSearch(rawQuery.search);

  const limitRaw = rawQuery.limit;
  const limit =
    limitRaw === undefined || limitRaw === null || limitRaw === ""
      ? 20
      : Number(limitRaw);

  const cursor =
    typeof rawQuery.cursor === "string" && rawQuery.cursor.trim()
      ? rawQuery.cursor.trim()
      : undefined;

  if (search.length > 100) {
    const error = new Error("Invalid query: search must be <= 100 chars");
    error.code = "VALIDATION_ERROR";
    throw error;
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    const error = new Error("Invalid query: limit must be an integer between 1 and 50");
    error.code = "VALIDATION_ERROR";
    throw error;
  }

  if (cursor && cursor.length > 500) {
    const error = new Error("Invalid query: cursor must be <= 500 chars");
    error.code = "VALIDATION_ERROR";
    throw error;
  }

  return Object.freeze({ search, limit, cursor });
}

function requireShopifySession(res) {
  const session = res.locals?.shopify?.session;

  if (!session?.shop) {
    const error = new Error("Unauthenticated Shopify session");
    error.code = "UNAUTHENTICATED";
    throw error;
  }

  return session;
}

function requireIdempotencyKey(req) {
  const idempotencyKey = req.get("Idempotency-Key")?.trim();

  if (!idempotencyKey) {
    const error = new Error("Idempotency-Key header is required");
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }

  return idempotencyKey;
}

function buildActorFromSession(session) {
  const associatedUser = session?.onlineAccessInfo?.associated_user;

  return Object.freeze({
    type: associatedUser?.id ? "SHOPIFY_USER" : "SHOPIFY_SESSION",
    userId: associatedUser?.id ? String(associatedUser.id) : null,
    email: associatedUser?.email || null,
  });
}

export const listCollections =
  (collectionService) => async (req, res, next) => {
    try {
      const session = requireShopifySession(res);
      const query = validateCollectionQuery(req.query, COLLECTION_LIST_KEYS);

      const command = Object.freeze({
        shop: session.shop,
        actor: buildActorFromSession(session),
        search: query.search,
        limit: query.limit,
        cursor: query.cursor,
      });

      const result = await collectionService.fetchCollections(command);

      return res
        .status(200)
        .json(toCollectionResponseDto(result, { isNameOnly: false }));
    } catch (error) {
      return next(error);
    }
  };

export const listCollectionOptions =
  (collectionService) => async (req, res, next) => {
    try {
      const session = requireShopifySession(res);
      const query = validateCollectionQuery(req.query, COLLECTION_OPTIONS_KEYS);

      const command = Object.freeze({
        shop: session.shop,
        actor: buildActorFromSession(session),
        search: query.search,
        limit: query.limit,
        cursor: query.cursor,
      });

      const result = await collectionService.fetchCollections(command);

      return res
        .status(200)
        .json(toCollectionResponseDto(result, { isNameOnly: true }));
    } catch (error) {
      return next(error);
    }
  };

export const listLiveCollections =
  (collectionService) => async (req, res, next) => {
    try {
      const session = requireShopifySession(res);
      const query = validateCollectionQuery(req.query, LIVE_COLLECTION_KEYS);

      const command = Object.freeze({
        shop: session.shop,
        actor: buildActorFromSession(session),
        search: query.search,
        limit: query.limit,
        cursor: query.cursor,
        subscription: req.subscription || null,
      });

      const result = await collectionService.fetchFromShopify(command);

      return res
        .status(200)
        .json(toCollectionResponseDto(result, { isNameOnly: false }));
    } catch (error) {
      return next(error);
    }
  };

export const requestCollectionRefresh =
  (collectionService) => async (req, res, next) => {
    try {
      const session = requireShopifySession(res);

      const command = Object.freeze({
        shop: session.shop,
        actor: buildActorFromSession(session),
        idempotencyKey: requireIdempotencyKey(req),
        subscription: req.subscription || null,
      });

      const result = await collectionService.requestCollectionRefresh(command);

      return res.status(202).json({
        success: true,
        data: toCollectionRefreshAcceptedDto(result),
        meta: { accepted: true },
      });
    } catch (error) {
      return next(error);
    }
  };
