import ProductBulkService from "../services/productService/productBulkEditService.js";
import UndoEditService from "../services/productService/productBulkUndoService.js";
import { clearAllCachesForShop } from "../utils/cacheUtils.js";
import { getTargetingVersionBundle } from "../services/targeting/versioning.js";

import { requestEditHistoryCancellation } from "../services/operationCancellationService.js";
import {
  requestPauseEditOperation,
  resumeEditOperation,
} from "../services/operationPauseResumeService.js";

const EMPTY_OBJECT = Object.freeze({});
const EMPTY_ARRAY = Object.freeze([]);

function buildUseCaseError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPlainCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw buildUseCaseError("Invalid bulk edit command");
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

function assertHistoryMutationCommand(command) {
  command = assertMutationCommand(command);
  assertRequiredString(command.historyId, "historyId");
  return command;
}

function assertEditPayload(command) {
  assertRequiredString(command.editedField, "editedField");
  assertRequiredString(command.editType, "editType");

  return command;
}

function assertScheduledCommand(command) {
  command = assertMutationCommand(command);
  assertEditPayload(command);

  assertRequiredString(command.scheduledAt, "scheduledAt");
  assertRequiredString(command.freezeMode, "freezeMode");

  return command;
}

function assertPreviewFingerprint(command) {
  assertRequiredString(command.previewId, "previewId", "PREVIEW_ID_REQUIRED");

  assertRequiredString(
    command.previewFilterHash,
    "previewFilterHash",
    "PREVIEW_FINGERPRINT_REQUIRED",
  );

  assertRequiredString(
    command.previewFieldRegistryVersion,
    "previewFieldRegistryVersion",
    "PREVIEW_REGISTRY_VERSION_REQUIRED",
  );

  assertRequiredString(
    command.previewOperatorRegistryVersion,
    "previewOperatorRegistryVersion",
    "PREVIEW_REGISTRY_VERSION_REQUIRED",
  );
}

function assertPreviewRegistryVersionMatches(command) {
  const current = getTargetingVersionBundle();

  const expectedFieldRegistryVersion = String(
    current?.fieldRegistryVersion || "",
  );

  const expectedOperatorRegistryVersion = String(
    current?.operatorRegistryVersion || "",
  );

  const actualFieldRegistryVersion = String(
    command.previewFieldRegistryVersion || "",
  );

  const actualOperatorRegistryVersion = String(
    command.previewOperatorRegistryVersion || "",
  );

  if (
    actualFieldRegistryVersion !== expectedFieldRegistryVersion ||
    actualOperatorRegistryVersion !== expectedOperatorRegistryVersion
  ) {
    throw buildUseCaseError(
      "PREVIEW_REGISTRY_VERSION_MISMATCH",
      "PREVIEW_REGISTRY_VERSION_MISMATCH",
    );
  }
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

function createProductBulkService(command) {
  return new ProductBulkService(buildServiceContext(command));
}

function createUndoEditService(command) {
  return new UndoEditService(buildServiceContext(command));
}

function requireResult(result, message = "Operation failed") {
  if (!result) {
    throw buildUseCaseError(message, "INTERNAL_ERROR");
  }

  return result;
}

function safeArray(value) {
  return Array.isArray(value) ? value : EMPTY_ARRAY;
}

async function clearShopCachesBestEffort(shop) {
  try {
    await clearAllCachesForShop(shop);
  } catch (error) {
    console.warn("[productBulkEditUseCases] Cache invalidation failed", {
      shop,
      code: error?.code || "CACHE_INVALIDATION_FAILED",
      message: error?.message || "Unknown cache invalidation failure",
    });
  }
}

function toPreviewServiceInput(command) {
  return Object.freeze({
    shop: command.shop,

    field: command.editedField,
    editedField: command.editedField,
    editType: command.editType,
    editValue: command.editValue,

    filterParams: safeArray(command.filterParams),
    filterAst: command.filterAst || null,
    searchKey: command.searchKey || null,
    replaceText: command.replaceText || null,
    supportValue: command.supportValue,
    locationId: command.locationId || null,
    operationKey: command.operationKey || null,
    productIds: safeArray(command.productIds),

    lang: command.lang || "en",
    cursor: command.cursor || null,
    limit: command.limit || null,

    actor: command.actor || null,
    subscription: command.subscription || null,
    entitlement: command.entitlement || null,
    activePlan: command.activePlan || EMPTY_OBJECT,
    actorId: command.actor?.actorId || command.actor?.userId || null,
  });
}

function toExecuteInnerCommand(command) {
  return Object.freeze({
    editedField: command.editedField,
    editType: command.editType,
    editValue: command.editValue,

    searchKey: command.searchKey || null,
    replaceText: command.replaceText || null,
    supportValue: command.supportValue,
    locationId: command.locationId || null,

    filterParams: safeArray(command.filterParams),
    filterAst: command.filterAst || null,

    previewId: command.previewId,
    previewFilterHash: command.previewFilterHash,
    previewMirrorBatchId: command.previewMirrorBatchId || null,
    previewFieldRegistryVersion: command.previewFieldRegistryVersion,
    previewOperatorRegistryVersion: command.previewOperatorRegistryVersion,

    confirmBroadTarget: Boolean(command.confirmBroadTarget),
    criticalConfirmationText: command.criticalConfirmationText || null,

    operationKey: command.operationKey || null,
    productIds: safeArray(command.productIds),
    title: command.title || null,
    cursor: command.cursor || null,
    limit: command.limit || null,
  });
}

function toExecuteServiceInput(command) {
  return Object.freeze({
    shop: command.shop,
    command: toExecuteInnerCommand(command),
    idempotencyKey: command.idempotencyKey,

    actor: command.actor || null,
    subscription: command.subscription || null,
    entitlement: command.entitlement || null,
    activePlan: command.activePlan || EMPTY_OBJECT,
  });
}

function toScheduleInnerCommand(command) {
  return Object.freeze({
    editedField: command.editedField,
    editType: command.editType,
    editValue: command.editValue,

    searchKey: command.searchKey || null,
    replaceText: command.replaceText || null,
    supportValue: command.supportValue,
    locationId: command.locationId || null,

    filterParams: safeArray(command.filterParams),
    filterAst: command.filterAst || null,
    productIds: safeArray(command.productIds),

    title: command.title || null,
    scheduledAt: command.scheduledAt,
    scheduledUndoAt: command.scheduledUndoAt || null,
    freezeMode: command.freezeMode,

    confirmBroadTarget: Boolean(command.confirmBroadTarget),
    criticalConfirmationText: command.criticalConfirmationText || null,
    operationKey: command.operationKey || null,

    previewId: command.previewId || null,
    previewFilterHash: command.previewFilterHash || null,
    previewMirrorBatchId: command.previewMirrorBatchId || null,
    previewFieldRegistryVersion: command.previewFieldRegistryVersion || null,
    previewOperatorRegistryVersion:
      command.previewOperatorRegistryVersion || null,
  });
}

function toScheduleServiceInput(command) {
  return Object.freeze({
    shop: command.shop,
    command: toScheduleInnerCommand(command),
    idempotencyKey: command.idempotencyKey,

    actor: command.actor || null,
    subscription: command.subscription || null,
    entitlement: command.entitlement || null,
    activePlan: command.activePlan || EMPTY_OBJECT,
  });
}

function toHistoryLifecycleInput(command) {
  return Object.freeze({
    shop: command.shop,
    historyId: command.historyId,
    idempotencyKey: command.idempotencyKey,

    actor: command.actor || null,
    subscription: command.subscription || null,
    entitlement: command.entitlement || null,
    activePlan: command.activePlan || EMPTY_OBJECT,
  });
}

function toUndoServiceInput(command) {
  return Object.freeze({
    ...toHistoryLifecycleInput(command),
  });
}

function toRetryFailedOnlyServiceInput(command) {
  return Object.freeze({
    ...toHistoryLifecycleInput(command),
  });
}

function toCancelServiceInput(command) {
  return Object.freeze({
    ...toHistoryLifecycleInput(command),
    reason: command.reason || null,
  });
}

function shouldValidateSchedulePreview(command) {
  return String(command.freezeMode || "") === "STATIC_AT_SCHEDULE_CREATE";
}

function assertSchedulePreviewPolicy(command) {
  if (!shouldValidateSchedulePreview(command)) {
    return;
  }

  assertPreviewFingerprint(command);
  assertPreviewRegistryVersionMatches(command);
}

export const productBulkEditUseCases = Object.freeze({
  async preview(command) {
    command = assertPlainCommand(command);
    assertEditPayload(command);

    const service = createProductBulkService(command);

    const result = await service.trackEditProducts(
      toPreviewServiceInput(command),
    );

    return requireResult(result, "Preview generation failed");
  },

  async execute(command) {
    command = assertMutationCommand(command);
    assertEditPayload(command);
    assertPreviewFingerprint(command);
    assertPreviewRegistryVersionMatches(command);

    const service = createProductBulkService(command);

    const result = await service.bulkEditProducts(
      toExecuteServiceInput(command),
    );

    requireResult(result, "Bulk edit execution failed");

    await clearShopCachesBestEffort(command.shop);

    return result;
  },

  async schedule(command) {
    command = assertScheduledCommand(command);
    assertSchedulePreviewPolicy(command);

    const service = createProductBulkService(command);

    const result = await service.createScheduledEdit(
      toScheduleServiceInput(command),
    );

    return requireResult(result, "Scheduled edit creation failed");
  },
});

export const productBulkUndoUseCases = Object.freeze({
  async undo(command) {
    command = assertHistoryMutationCommand(command);

    const service = createUndoEditService(command);

    const result = await service.undoEdit(toUndoServiceInput(command));

    return requireResult(result, "Undo operation failed");
  },
});

export const productOperationLifecycleUseCases = Object.freeze({
  async cancel(command) {
    command = assertHistoryMutationCommand(command);

    const result = await requestEditHistoryCancellation(
      toCancelServiceInput(command),
    );

    return requireResult(result, "Cancellation request failed");
  },

  async pause(command) {
    command = assertHistoryMutationCommand(command);

    const result = await requestPauseEditOperation(
      toHistoryLifecycleInput(command),
    );

    return requireResult(result, "Pause request failed");
  },

  async resume(command) {
    command = assertHistoryMutationCommand(command);

    const result = await resumeEditOperation(toHistoryLifecycleInput(command));

    return requireResult(result, "Resume request failed");
  },

  async retryFailedOnly(command) {
    command = assertHistoryMutationCommand(command);

    const service = createProductBulkService(command);

    const result = await service.retryFailedOnly(
      toRetryFailedOnlyServiceInput(command),
    );

    return requireResult(result, "Retry failed-only request failed");
  },
});
