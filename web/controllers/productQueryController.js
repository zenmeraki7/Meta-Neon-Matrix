import {
  buildAuthenticatedActor,
  handleControllerError,
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
  toBulkEditStatusDto,
  toFilterRegistryDto,
  toProductOptionListDto,
  toProductQueryResponseDto,
} from "../dtos/productQueryDto.js";

function setPrivateNoStore(res) {
  if (res?.headersSent) {
    return;
  }

  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function assertFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }

  return value;
}

export function createProductQueryController({
  executeProductQuery,
  getBulkEditStatus,
  getPreviewFilterRegistry,
  getProductFilterValueOptions,
  getProductTypeOptions,
}) {
  const queryProducts = assertFunction(
    executeProductQuery,
    "executeProductQuery",
  );

  const readBulkEditStatus = assertFunction(
    getBulkEditStatus,
    "getBulkEditStatus",
  );

  const readFilterRegistry = assertFunction(
    getPreviewFilterRegistry,
    "getPreviewFilterRegistry",
  );

  const readFilterValueOptions = assertFunction(
    getProductFilterValueOptions,
    "getProductFilterValueOptions",
  );

  const readProductTypeOptions = assertFunction(
    getProductTypeOptions,
    "getProductTypeOptions",
  );

  async function getProductsWithQuery(req, res) {
    try {
      const { session, shop } = requireShopifySession(res);

      const command = buildProductQueryCommand({
        shop,
        actor: buildAuthenticatedActor(req, session, shop),
        query: req.query ?? {},
        body: req.body ?? {},
      });

      const result = await queryProducts(command);

      setPrivateNoStore(res);

      return res
        .status(200)
        .json(toProductQueryResponseDto(result));
    } catch (error) {
      setPrivateNoStore(res);

      return handleControllerError(
        req,
        res,
        error,
        "PRODUCT_QUERY_FAILED",
        "productQueryController.getProductsWithQuery",
      );
    }
  }

  async function checkEditStatus(req, res) {
    try {
      const { session, shop } = requireShopifySession(res);

      const command = buildBulkEditStatusCommand({
        shop,
        actor: buildAuthenticatedActor(req, session, shop),
        params: req.params ?? {},
      });

      const result = await readBulkEditStatus(command);

      setPrivateNoStore(res);

      return res
        .status(200)
        .json(toBulkEditStatusDto(result));
    } catch (error) {
      setPrivateNoStore(res);

      return handleControllerError(
        req,
        res,
        error,
        "BULK_EDIT_STATUS_FAILED",
        "productQueryController.checkEditStatus",
      );
    }
  }

  async function getProductTypes(req, res) {
    try {
      const { session, shop } = requireShopifySession(res);

      const command = buildProductTypeOptionsCommand({
        shop,
        actor: buildAuthenticatedActor(req, session, shop),
        query: req.query ?? {},
      });

      const result = await readProductTypeOptions(command);

      setPrivateNoStore(res);

      return res
        .status(200)
        .json(toProductOptionListDto(result));
    } catch (error) {
      setPrivateNoStore(res);

      return handleControllerError(
        req,
        res,
        error,
        "PRODUCT_TYPE_OPTIONS_FAILED",
        "productQueryController.getProductTypes",
      );
    }
  }

  async function getProductFilterValues(req, res) {
    try {
      const { session, shop } = requireShopifySession(res);

      const command = buildProductFilterValueOptionsCommand({
        shop,
        actor: buildAuthenticatedActor(req, session, shop),
        params: req.params ?? {},
        query: req.query ?? {},
      });

      const result = await readFilterValueOptions(command);

      setPrivateNoStore(res);

      return res
        .status(200)
        .json(toProductOptionListDto(result));
    } catch (error) {
      setPrivateNoStore(res);

      return handleControllerError(
        req,
        res,
        error,
        "PRODUCT_FILTER_VALUES_FAILED",
        "productQueryController.getProductFilterValues",
      );
    }
  }

  async function getFilterRegistry(req, res) {
    try {
      const { session, shop } = requireShopifySession(res);

      const command = buildFilterRegistryCommand({
        shop,
        actor: buildAuthenticatedActor(req, session, shop),
        query: req.query ?? {},
      });

      const result = await readFilterRegistry(command);

      setPrivateNoStore(res);

      return res
        .status(200)
        .json(toFilterRegistryDto(result));
    } catch (error) {
      setPrivateNoStore(res);

      return handleControllerError(
        req,
        res,
        error,
        "FILTER_REGISTRY_FAILED",
        "productQueryController.getFilterRegistry",
      );
    }
  }

  return Object.freeze({
    getProductsWithQuery,
    checkEditStatus,
    getProductTypes,
    getProductFilterValues,
    getFilterRegistry,
  });
}

import {
  getProductsWithQuery,
  checkEditStatus,
  getProductTypes,
  getProductFilterValues,
  getFilterRegistry,
} from "./productQueryComposition.js";

export {
  getProductsWithQuery,
  checkEditStatus,
  getProductTypes,
  getProductFilterValues,
  getFilterRegistry,
};
