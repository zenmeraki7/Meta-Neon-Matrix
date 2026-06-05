import {
  createScheduledExport,
  deleteScheduledExport,
  getScheduledExportById,
  listScheduledExports,
  toggleScheduledExportStatus,
  updateScheduledExport,
} from "../services/scheduledExportService.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import {
  normalizeCreateScheduledExportCommand,
  normalizeDeleteScheduledExportCommand,
  normalizeGetScheduledExportCommand,
  normalizeListScheduledExportsCommand,
  normalizeToggleScheduledExportStatusCommand,
  normalizeUpdateScheduledExportCommand,
} from "../normalizers/scheduledExportCommandNormalizer.js";
import { toSuccessResponse } from "../dtos/apiResponseDto.js";
import { toScheduledExportDto } from "../dtos/scheduledExportDto.js";

async function handleScheduledExportControllerError({ req, res, error, source }) {
  await logApiError({
    shop: res.locals?.shopify?.session?.shop,
    err: error,
    req,
    source,
  });

  const { statusCode, body } = buildPublicApiErrorResponse(
    error,
    "INTERNAL_ERROR",
  );
  return res.status(statusCode).json(body);
}

function sendScheduledExportResponse(res, statusCode, data) {
  return res.status(statusCode).json(
    toSuccessResponse(toScheduledExportDto(data)),
  );
}

export async function createScheduledExportController(req, res) {
  try {
    const session = res.locals.shopify.session;
    const locals = { ...res.locals, shopify: { ...res.locals.shopify, session } };
    const command = normalizeCreateScheduledExportCommand(
      req.params,
      req.body,
      locals,
    );
    const data = await createScheduledExport(command);

    return sendScheduledExportResponse(res, 201, data);
  } catch (error) {
    return handleScheduledExportControllerError({
      req,
      res,
      error,
      source: "scheduledExportController.create",
    });
  }
}

export async function listScheduledExportsController(req, res) {
  try {
    const session = res.locals.shopify.session;
    const locals = { ...res.locals, shopify: { ...res.locals.shopify, session } };
    const command = normalizeListScheduledExportsCommand(
      req.params,
      req.body,
      locals,
    );
    const data = await listScheduledExports(command);

    return sendScheduledExportResponse(res, 200, data);
  } catch (error) {
    return handleScheduledExportControllerError({
      req,
      res,
      error,
      source: "scheduledExportController.list",
    });
  }
}

export async function getScheduledExportByIdController(req, res) {
  try {
    const session = res.locals.shopify.session;
    const locals = { ...res.locals, shopify: { ...res.locals.shopify, session } };
    const command = normalizeGetScheduledExportCommand(
      req.params,
      req.body,
      locals,
    );
    const data = await getScheduledExportById(command);

    return sendScheduledExportResponse(res, 200, data);
  } catch (error) {
    return handleScheduledExportControllerError({
      req,
      res,
      error,
      source: "scheduledExportController.getById",
    });
  }
}

export async function updateScheduledExportController(req, res) {
  try {
    const session = res.locals.shopify.session;
    const locals = { ...res.locals, shopify: { ...res.locals.shopify, session } };
    const command = normalizeUpdateScheduledExportCommand(
      req.params,
      req.body,
      locals,
    );
    const data = await updateScheduledExport(command);

    return sendScheduledExportResponse(res, 200, data);
  } catch (error) {
    return handleScheduledExportControllerError({
      req,
      res,
      error,
      source: "scheduledExportController.update",
    });
  }
}

export async function toggleScheduledExportStatusController(req, res) {
  try {
    const session = res.locals.shopify.session;
    const locals = { ...res.locals, shopify: { ...res.locals.shopify, session } };
    const command = normalizeToggleScheduledExportStatusCommand(
      req.params,
      req.body,
      locals,
    );
    const data = await toggleScheduledExportStatus(command);

    return sendScheduledExportResponse(res, 200, data);
  } catch (error) {
    return handleScheduledExportControllerError({
      req,
      res,
      error,
      source: "scheduledExportController.toggleStatus",
    });
  }
}

export async function deleteScheduledExportController(req, res) {
  try {
    const session = res.locals.shopify.session;
    const locals = { ...res.locals, shopify: { ...res.locals.shopify, session } };
    const command = normalizeDeleteScheduledExportCommand(
      req.params,
      req.body,
      locals,
    );
    const data = await deleteScheduledExport(command);

    return sendScheduledExportResponse(res, 200, data);
  } catch (error) {
    return handleScheduledExportControllerError({
      req,
      res,
      error,
      source: "scheduledExportController.delete",
    });
  }
}
