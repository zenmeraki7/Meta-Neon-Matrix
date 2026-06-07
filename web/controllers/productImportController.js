import fs from "fs";
import {
  buildAuthenticatedActor,
  getIdempotencyKey,
  handleLoggedControllerError,
  requireShopifySession,
} from "./controllerUtils.js";
import {
  createCsvPreview,
  previewCsvPage,
} from "../services/productImport/productImportPreviewService.js";
import {
  buildCreateCsvPreviewCommand,
  buildCreateProductImportCommand,
  buildPreviewCsvPageCommand,
} from "../normalizers/productImportCommandNormalizer.js";
import {
  toCsvPreviewPageDto,
  toCsvPreviewResponseDto,
  toProductImportAcceptedDto,
} from "../dtos/productImportDto.js";

function removeUploadedFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // no-op
  }
}

export const createImportCsvController = (productImportCommandService) => async (req, res) => {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildCreateProductImportCommand({
      file: req.file,
      body: req.body || {},
      idempotencyKey: req.headers["idempotency-key"] || getIdempotencyKey(req),
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
    });

    const result = await productImportCommandService.createImportCommand(command);

    return res.status(202).json(toProductImportAcceptedDto(result));
  } catch (error) {
    removeUploadedFile(req.file?.path);
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productImportController.importCsv",
      fallbackCode: "PRODUCT_IMPORT_FAILED",
    });
  }
};

export const previewCsvController = async (req, res) => {
  let session;

  try {
    session = requireShopifySession(res);

    const command = buildPreviewCsvPageCommand({
      query: req.query || {},
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
    });

    const result = await previewCsvPage(command);
    return res.status(200).json(toCsvPreviewPageDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productImportController.previewCsv",
      fallbackCode: "CSV_PREVIEW_FAILED",
    });
  }
};

export const createCsvPreviewController = async (req, res) => {
  let session;

  try {
    session = requireShopifySession(res);

    const command = buildCreateCsvPreviewCommand({
      file: req.file,
      query: req.query || {},
      idempotencyKey: getIdempotencyKey(req),
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
    });

    const result = await createCsvPreview(command);
    const responseDto = toCsvPreviewResponseDto(result);

    return res.status(responseDto.statusCode).json(responseDto.body);
  } catch (error) {
    removeUploadedFile(req.file?.path);
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productImportController.createCsvPreview",
      fallbackCode: "CSV_PREVIEW_FAILED",
    });
  }
};
