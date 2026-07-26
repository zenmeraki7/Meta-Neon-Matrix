import fs from "fs";
import {
  buildAuthenticatedActor,
  getRequiredIdempotencyKey,
  handleControllerError,
  requireShopifySession,
} from "./controllerUtils.js";
import { logWorkerError } from "../utils/errorLogUtils.js";
import { ProductImportCommandService } from "../services/productImport/ProductImportCommandService.js";
import { productImportPreviewService as defaultProductImportPreviewService } from "../services/productImport/productImportPreviewService.js";
import {
  buildCreateCsvPreviewCommand,
  buildCreateProductImportCommand,
  buildPreviewCsvPageCommand,
} from "../normalizers/productImportCommandNormalizer.js";
import {
  toCsvPreviewAcceptedDto as defaultToCsvPreviewAcceptedDto,
  toCsvPreviewPageDto as defaultToCsvPreviewPageDto,
  toProductImportAcceptedDto as defaultToProductImportCommandAcceptedDto,
} from "../dtos/productImportDto.js";

const defaultProductImportCommandService = new ProductImportCommandService();

export async function removeUploadedFile(filePath) {
  if (!filePath) return;

  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logWorkerError({
        err: error,
        source: "productImportController.removeUploadedFile",
        metadata: {
          errorCode: error?.code,
          errorName: error?.name,
        },
      });
    }
  }
}

function buildContext(req, session, shop) {
  return Object.freeze({
    shop,
    actor: buildAuthenticatedActor(req, session, shop),
  });
}

export function createProductImportController({
  productImportCommandService = defaultProductImportCommandService,
  productImportPreviewService = defaultProductImportPreviewService,
  removeUploadedFile: removeFile = removeUploadedFile,
  toProductImportCommandAcceptedDto = defaultToProductImportCommandAcceptedDto,
  toCsvPreviewAcceptedDto = defaultToCsvPreviewAcceptedDto,
  toCsvPreviewPageDto = defaultToCsvPreviewPageDto,
} = {}) {
  async function importCsvController(req, res) {
    let uploadTransferred = false;

    try {
      const { session, shop } = requireShopifySession(req, res);

      const command = buildCreateProductImportCommand({
        file: req.file,
        body: req.body ?? {},
        idempotencyKey: getRequiredIdempotencyKey(req),
        context: buildContext(req, session, shop),
      });

      const result = await productImportCommandService.createImportCommand(command);

      uploadTransferred =
        result?.uploadOwnershipTransferred === true ||
        result?.fileOwnershipTransferred === true ||
        Boolean(result?.operationId);

      return res
        .status(202)
        .json(toProductImportCommandAcceptedDto(result));
    } catch (error) {
      if (!uploadTransferred) {
        await removeFile(req.file?.path);
      }

      return handleControllerError(
        req,
        res,
        error,
        "PRODUCT_IMPORT_FAILED",
        "productImportController.importCsvController",
      );
    }
  }

  async function previewCsvController(req, res) {
    try {
      const { session, shop } = requireShopifySession(req, res);

      const command = buildPreviewCsvPageCommand({
        query: req.query ?? {},
        context: buildContext(req, session, shop),
      });

      const result = await productImportPreviewService.previewCsvPage(command);

      return res.status(200).json(toCsvPreviewPageDto(result));
    } catch (error) {
      return handleControllerError(
        req,
        res,
        error,
        "CSV_PREVIEW_FAILED",
        "productImportController.previewCsvController",
      );
    }
  }

  async function createCsvPreviewController(req, res) {
    let uploadTransferred = false;

    try {
      const { session, shop } = requireShopifySession(req, res);

      const command = buildCreateCsvPreviewCommand({
        file: req.file,
        query: req.query ?? {},
        idempotencyKey: getRequiredIdempotencyKey(req),
        context: buildContext(req, session, shop),
      });

      const result = await productImportPreviewService.createCsvPreview(command);

      uploadTransferred =
        result?.uploadOwnershipTransferred === true ||
        result?.durable === true ||
        Boolean(result?.uploadToken);

      return res
        .status(202)
        .json(toCsvPreviewAcceptedDto(result));
    } catch (error) {
      if (!uploadTransferred) {
        await removeFile(req.file?.path);
      }

      return handleControllerError(
        req,
        res,
        error,
        "CSV_PREVIEW_FAILED",
        "productImportController.createCsvPreviewController",
      );
    }
  }

  return Object.freeze({
    importCsvController,
    previewCsvController,
    createCsvPreviewController,
  });
}

const defaultController = createProductImportController();

export const {
  importCsvController,
  previewCsvController,
  createCsvPreviewController,
} = defaultController;
