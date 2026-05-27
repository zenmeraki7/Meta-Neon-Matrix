import FilterCombinationService from "../services/filterCombination/FilterCombinationService.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

const filterCombinationService = new FilterCombinationService();

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

export const addFilterCombination = async (req, res) => {
  try {
    const session = res.locals?.shopify?.session;
    if (!session?.shop) {
      return res.status(401).json({
        success: false,
        code: "UNAUTHENTICATED",
        message: "Session expired",
      });
    }

    const saved = await filterCombinationService.add({
      shop: session.shop,
      filterParams: req.body?.filterParams,
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

export const getFilterCombinations = async (req, res) => {
  try {
    const session = res.locals?.shopify?.session;
    if (!session?.shop) {
      return res.status(401).json({
        success: false,
        code: "UNAUTHENTICATED",
        message: "Session expired",
      });
    }

    const result = await filterCombinationService.list({ shop: session.shop });
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

export const updateFilterCombination = async (req, res) => {
  try {
    const session = res.locals?.shopify?.session;
    if (!session?.shop) {
      return res.status(401).json({
        success: false,
        code: "UNAUTHENTICATED",
        message: "Session expired",
      });
    }

    const updated = await filterCombinationService.update({
      shop: session.shop,
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

export const deleteFilterCombination = async (req, res) => {
  try {
    const session = res.locals?.shopify?.session;
    if (!session?.shop) {
      return res.status(401).json({
        success: false,
        code: "UNAUTHENTICATED",
        message: "Session expired",
      });
    }

    await filterCombinationService.remove({
      shop: session.shop,
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

