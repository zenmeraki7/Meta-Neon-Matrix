import {
  buildAuthenticatedActor,
  handleLoggedControllerError,
  requireShopifySession,
} from "./controllerUtils.js";
import {
  buildBulkEditStatusCommand,
  buildFilterRegistryCommand,
  buildProductFilterValueOptionsCommand,
  buildProductQueryCommand,
  buildProductTypeOptionsCommand,
} from "../normalizers/productQueryCommandNormalizer.js";
import {
  executeProductQuery,
  getPreviewFilterRegistry,
  getProductFilterValueOptions,
  getProductTypeOptions,
} from "../services/productService/productQueryCommandService.js";
import { getBulkEditStatus } from "../services/productService/bulkEditStatusService.js";
import {
  toBulkEditStatusDto,
  toFilterRegistryDto,
  toProductOptionListDto,
  toProductQueryResponseDto,
} from "../dtos/productQueryDto.js";

export const getProductsWithQuery = async (req, res) => {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildProductQueryCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      query: req.query,
      body: req.body,
    });
    const result = await executeProductQuery(command);
    return res.status(200).json(toProductQueryResponseDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productQueryController.getProductsWithQuery",
      fallbackCode: "PRODUCT_QUERY_FAILED",
    });
  }
};

export const checkEditStatus = async (req, res) => {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildBulkEditStatusCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      params: req.params,
    });
    const result = await getBulkEditStatus(command);
    return res.status(200).json(toBulkEditStatusDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productQueryController.checkEditStatus",
      fallbackCode: "BULK_EDIT_STATUS_FAILED",
    });
  }
};

export const getProductTypes = async (req, res) => {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildProductTypeOptionsCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      query: req.query,
    });
    const result = await getProductTypeOptions(command);
    return res.status(200).json(toProductOptionListDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productQueryController.getProductTypes",
      fallbackCode: "PRODUCT_TYPE_OPTIONS_FAILED",
    });
  }
};

export const getProductFilterValues = async (req, res) => {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildProductFilterValueOptionsCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      params: req.params,
      query: req.query,
    });
    const result = await getProductFilterValueOptions(command);
    return res.status(200).json(toProductOptionListDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productQueryController.getProductFilterValues",
      fallbackCode: "PRODUCT_FILTER_VALUES_FAILED",
    });
  }
};

export const getFilterRegistry = async (req, res) => {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildFilterRegistryCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      query: req.query,
    });
    const result = await getPreviewFilterRegistry(command);
    return res.status(200).json(toFilterRegistryDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productQueryController.getFilterRegistry",
      fallbackCode: "FILTER_REGISTRY_FAILED",
    });
  }
};
