// web/useCases/productExportUseCases.js

import { ProductExportCommandService } from "../services/productExport/ProductExportCommandService.js";
import { requestExportJobCancellation } from "../services/operationCancellationService.js";
import {
  requestPauseExportOperation,
  resumeExportOperation,
} from "../services/operationPauseResumeService.js";
import {
  assertSupportedExportFields as assertRegisteredExportFields,
} from "../services/productService/productExportFieldRegistry.js";

const EMPTY_OBJECT = Object.freeze({});
const EMPTY_ARRAY = Object.freeze([]);

const SAFE_REDIRECT_PROTOCOLS = new Set(["https:"]);

function buildUseCaseError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPlainCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw buildUseCaseError("Invalid export command");
  }

  if (!command.shop || typeof command.shop !== "string") {
    throw buildUseCaseError("Authentication required", "UNAUTHENTICATED");
  }

  return command;
}

function assertRequiredString(value, fieldName, code = "VALIDATION_FAILED") {
  if (!value || typeof value !== "string") {
    throw buildUseCaseError(`${fieldName} is required`, code);
  }

  return value;
}

function assertMutationCommand(command) {
  command = assertPlainCommand(command);

  assertRequiredString(
    command.idempotencyKey,
    "Idempotency-Key",
    "IDEMPOTENCY_KEY_REQUIRED",
  );

  return command;
}

function assertExportJobCommand(command) {
  command = assertPlainCommand(command);
  assertRequiredString(command.exportJobId, "exportJobId");
  return command;
}

function assertExportJobMutationCommand(command) {
  command = assertMutationCommand(command);
  assertRequiredString(command.exportJobId, "exportJobId");
  return command;
}

function assertCreateExportCommand(command) {
  command = assertMutationCommand(command);

  if (!Array.isArray(command.fields) || command.fields.length === 0) {
    throw buildUseCaseError("FIELDS_REQUIRED", "VALIDATION_FAILED");
  }

  assertRequiredString(command.fileName, "fileName", "VALIDATION_FAILED");

  return command;
}

function requireResult(result, message = "Export operation failed") {
  if (!result) {
    throw buildUseCaseError(message, "INTERNAL_ERROR");
  }

  return result;
}

function buildServiceContext(command) {
  return Object.freeze({
    shop: command.shop,
    actor: command.actor || null,
    subscription: command.subscription || null,
    entitlement: command.entitlement || null,
    activePlan: command.activePlan || EMPTY_OBJECT,
  });
}

function createProductExportCommandService(command) {
  return new ProductExportCommandService(buildServiceContext(command));
}

function safeArray(value) {
  return Array.isArray(value) ? value : EMPTY_ARRAY;
}

function toCreateExportServiceInput(command) {
  return Object.freeze({
    shop: command.shop,
    fields: safeArray(command.fields),
    fileName: command.fileName,
    rawFilterInput: safeArray(command.rawFilterInput),
    filterAst: command.filterAst || null,
    options: command.options || EMPTY_OBJECT,
    idempotencyKey: command.idempotencyKey,

    // Transitional compatibility fields.
    // Remove once ProductExportCommandService reads context from constructor only.
    actor: command.actor || null,
    subscription: command.subscription || null,
    entitlement: command.entitlement || null,
    activePlan: command.activePlan || EMPTY_OBJECT,
  });
}

function toDownloadServiceInput(command) {
  return Object.freeze({
    shop: command.shop,
    exportJobId: command.exportJobId,

    // Transitional compatibility fields.
    // Remove once ProductExportCommandService reads context from constructor only.
    actor: command.actor || null,
    subscription: command.subscription || null,
    entitlement: command.entitlement || null,
    activePlan: command.activePlan || EMPTY_OBJECT,
  });
}

function toLifecycleServiceInput(command) {
  return Object.freeze({
    shop: command.shop,
    exportJobId: command.exportJobId,
    idempotencyKey: command.idempotencyKey,

    // Transitional compatibility fields.
    // Remove once lifecycle services receive context from their use-case boundary only.
    actor: command.actor || null,
    subscription: command.subscription || null,
    entitlement: command.entitlement || null,
    activePlan: command.activePlan || EMPTY_OBJECT,
  });
}

function toCancelServiceInput(command) {
  return Object.freeze({
    ...toLifecycleServiceInput(command),
    reason: command.reason || null,
  });
}

function assertSupportedExportFields(fields, options = EMPTY_OBJECT) {
  const safeFields = safeArray(fields);
  return assertRegisteredExportFields(safeFields, options).map((field) => field.key);
}

function getAllowedDownloadHosts() {
  const raw = process.env.EXPORT_DOWNLOAD_ALLOWED_HOSTS || "";

  return new Set(
    raw
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

function assertDownloadUrlSafe(downloadUrl) {
  assertRequiredString(downloadUrl, "downloadUrl", "EXPORT_FILE_NOT_READY");

  let parsed;

  try {
    parsed = new URL(downloadUrl);
  } catch {
    throw buildUseCaseError("EXPORT_DOWNLOAD_URL_INVALID", "INTERNAL_ERROR");
  }

  if (!SAFE_REDIRECT_PROTOCOLS.has(parsed.protocol)) {
    throw buildUseCaseError("EXPORT_DOWNLOAD_URL_UNSAFE", "INTERNAL_ERROR");
  }

  const allowedHosts = getAllowedDownloadHosts();

  if (allowedHosts.size > 0 && !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw buildUseCaseError("EXPORT_DOWNLOAD_URL_HOST_UNSAFE", "INTERNAL_ERROR");
  }

  return parsed.toString();
}

function normalizeDownloadResult(result) {
  requireResult(result, "Export history not found");

  const downloadUrl = result.downloadUrl || result.downloadUrl || null;
  const safeDownloadUrl = assertDownloadUrlSafe(downloadUrl);

  return Object.freeze({
    exportJobId: result.exportJobId || result.id || null,
    status: result.status || result.executionState || null,
    downloadUrl: safeDownloadUrl,
    fileName: result.fileName || result.filename || null,
    ready: true,
  });
}

export const productExportUseCases = Object.freeze({
  async create(command) {
    command = assertCreateExportCommand(command);

    const normalizedFields = assertSupportedExportFields(
      command.fields,
      command.options,
    );

    const service = createProductExportCommandService(command);

    const result = await service.createExportCommand(
      toCreateExportServiceInput({
        ...command,
        fields: normalizedFields,
      }),
    );

    return requireResult(result, "Export command creation failed");
  },

  async download(command) {
    command = assertExportJobCommand(command);

    const service = createProductExportCommandService(command);

    /**
     * ProductExportCommandService.getExportDetails MUST load by:
     * { shop, exportJobId }
     *
     * It must never fetch export records by id alone.
     */
    const result = await service.getExportDetails(
      toDownloadServiceInput(command),
    );

    return normalizeDownloadResult(result);
  },
});

export const productExportLifecycleUseCases = Object.freeze({
  async cancel(command) {
    command = assertExportJobMutationCommand(command);

    const result = await requestExportJobCancellation(
      toCancelServiceInput(command),
    );

    return requireResult(result, "Export cancellation request failed");
  },

  async pause(command) {
    command = assertExportJobMutationCommand(command);

    const result = await requestPauseExportOperation(
      toLifecycleServiceInput(command),
    );

    return requireResult(result, "Export pause request failed");
  },

  async resume(command) {
    command = assertExportJobMutationCommand(command);

    const result = await resumeExportOperation(
      toLifecycleServiceInput(command),
    );

    return requireResult(result, "Export resume request failed");
  },
});
