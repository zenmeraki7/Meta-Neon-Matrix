// web/controllers/collectionController.js
import {
  toCollectionRefreshAcceptedDto,
  toCollectionResponseDto,
} from "../dtos/collectionDto.js";
import { requireShopifySession } from "../http/shopifySession.js";
import { buildActorFromSession } from "../http/actorContext.js";
import {
  validateCollectionQuery,
  COLLECTION_LIST_KEYS,
  COLLECTION_OPTIONS_KEYS,
  LIVE_COLLECTION_KEYS,
} from "../validators/collectionRequestValidator.js";

function requireIdempotencyKey(req) {
  const idempotencyKey = req.get("Idempotency-Key")?.trim();

  if (!idempotencyKey) {
    const error = new Error("Idempotency-Key header is required");
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }

  return idempotencyKey;
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
