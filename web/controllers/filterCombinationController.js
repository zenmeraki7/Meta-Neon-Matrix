import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import { requireShopifySession } from "../http/shopifySession.js";
import { buildActorFromSession } from "../http/actorContext.js";
import { setPrivateNoStore } from "../http/cacheHeaders.js";

function toFilterCombinationDto(item) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    filters: item.filters,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export const addFilterCombination =
  (filterCombinationService) => async (req, res, next) => {
    try {
      setPrivateNoStore(res);
      const session = requireShopifySession(res, "Session expired");

      const saved = await filterCombinationService.add({
        shop: session.shop,
        actor: buildActorFromSession(session),
        rawFilterInput: req.body?.rawFilterInput,
        customTitle: req.body?.customTitle,
      });

      return res.status(201).json({
        success: true,
        message: "Filter combination saved successfully",
        data: toFilterCombinationDto(saved),
      });
    } catch (error) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        error,
        "VALIDATION_FAILED",
      );
      return res.status(statusCode).json(body);
    }
  };

export const getFilterCombinations =
  (filterCombinationService) => async (req, res, next) => {
    try {
      setPrivateNoStore(res);
      const session = requireShopifySession(res, "Session expired");

      const result = await filterCombinationService.list({
        shop: session.shop,
        actor: buildActorFromSession(session),
      });

      return res.status(200).json({
        success: true,
        message: "Filter combinations fetched successfully",
        data: result.map(toFilterCombinationDto),
      });
    } catch (error) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        error,
        "INTERNAL_ERROR",
      );
      return res.status(statusCode).json(body);
    }
  };

export const updateFilterCombination =
  (filterCombinationService) => async (req, res, next) => {
    try {
      setPrivateNoStore(res);
      const session = requireShopifySession(res, "Session expired");

      const updated = await filterCombinationService.update({
        shop: session.shop,
        actor: buildActorFromSession(session),
        id: req.params.id,
        filters: req.body?.filters,
      });

      return res.status(200).json({
        success: true,
        message: "Filter combination updated successfully",
        data: toFilterCombinationDto(updated),
      });
    } catch (error) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        error,
        "VALIDATION_FAILED",
      );
      return res.status(statusCode).json(body);
    }
  };

export const deleteFilterCombination =
  (filterCombinationService) => async (req, res, next) => {
    try {
      setPrivateNoStore(res);
      const session = requireShopifySession(res, "Session expired");

      await filterCombinationService.remove({
        shop: session.shop,
        actor: buildActorFromSession(session),
        id: req.params.id,
      });

      return res.status(200).json({
        success: true,
        message: "Filter combination deleted successfully",
      });
    } catch (error) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        error,
        "VALIDATION_FAILED",
      );
      return res.status(statusCode).json(body);
    }
  };
