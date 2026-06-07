import { jsonResponse } from "../lib/serialise.js";
import { normalizeCommitBulkEditSessionCommand } from "../normalizers/sessionCommitCommandNormalizer.js";
import {
  normalizeColumnApplySessionChangesCommand,
  normalizeStageSessionChangesCommand,
} from "../normalizers/sessionChangeCommandNormalizer.js";
import { commitBulkEditSessionUseCase } from "../useCases/commitBulkEditSessionUseCase.js";
import {
  applyColumnSessionChanges,
  stageSessionChanges,
} from "../useCases/sessionChangeUseCases.js";

function statusCodeForSessionError(error) {
  switch (error?.code) {
    case "SESSION_NOT_FOUND":
      return 404;
    case "SESSION_NOT_OPEN":
    case "SESSION_STATUS_INVALID":
      return 409;
    case "NO_PENDING_CHANGES":
      return 422;
    case "BULK_WRITE_JOB_CREATION_FAILED":
      return 503;
    case "VALIDATION_FAILED":
    case "SHOP_SCOPE_REQUIRED":
      return 400;
    default:
      return 500;
  }
}

export async function stageChangesController(req, res) {
  try {
    const command = normalizeStageSessionChangesCommand(req.params, req.body, {
      ...res.locals,
      idempotencyKey: req.headers?.["idempotency-key"] || req.headers?.["Idempotency-Key"] || null,
    });
    const result = await stageSessionChanges(command);
    jsonResponse(res, result, 201);
  } catch (error) {
    const statusCode = statusCodeForSessionError(error);
    const body = { error: error?.message || "Failed to stage changes" };
    if (error?.code) body.code = error.code;
    if (Array.isArray(error?.fields) && error.fields.length > 0) body.fields = error.fields;
    jsonResponse(res, body, statusCode);
  }
}

export async function columnApplyController(req, res) {
  try {
    const command = normalizeColumnApplySessionChangesCommand(
      req.params,
      req.body,
      {
        ...res.locals,
        idempotencyKey: req.headers?.["idempotency-key"] || req.headers?.["Idempotency-Key"] || null,
      },
    );
    const result = await applyColumnSessionChanges(command);
    jsonResponse(res, result, 201);
  } catch (error) {
    const statusCode = statusCodeForSessionError(error);
    const body = { error: error?.message || "Failed to apply column changes" };
    if (error?.code) body.code = error.code;
    if (Array.isArray(error?.fields) && error.fields.length > 0) body.fields = error.fields;
    jsonResponse(res, body, statusCode);
  }
}

export async function commitSessionController(req, res) {
  try {
    const command = normalizeCommitBulkEditSessionCommand(req.params, res.locals, req.headers || {});
    const result = await commitBulkEditSessionUseCase(command);
    jsonResponse(res, result);
  } catch (error) {
    const statusCode = statusCodeForSessionError(error);
    const body = {
      error: error?.message || "Failed to commit session",
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.retryable !== undefined
        ? { retryable: Boolean(error.retryable) }
        : {}),
    };
    jsonResponse(
      res,
      body,
      statusCode,
    );
  }
}
