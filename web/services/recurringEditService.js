import { db } from "../repositories/repositoryDb.js";
import { getUpdatedProducts } from "../helpers/productBulkOperationHelpers/productUpdateHandler.js";
import { recurringEditRepository } from "../repositories/recurringEditRepository.js";
import { recurringEditRunRepository } from "../repositories/recurringEditRunRepository.js";
import { findPreviewContractRecord } from "../repositories/bulkEditCommandRepository.js";
import {
  assertPaidRecurringEditAccess,
  assertRecurringEditActiveLimit,
} from "./recurringEditPlanService.js";
import {
  buildRecurringScheduleInput,
  computeRecurringEditNextRunAt,
} from "./recurringEditScheduleService.js";
import logger from "../utils/loggerUtils.js";
import { TargetingEngineService } from "./targeting/TargetingEngineService.js";
import { planMutationExecution } from "./bulkEdit/planner/mutationPlanner.js";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const CANONICAL_FIELD_BY_UI_FIELD = Object.freeze({
  price: "VARIANT_PRICE",
  compareAtPrice: "VARIANT_COMPARE_AT_PRICE",
  compare_at_price: "VARIANT_COMPARE_AT_PRICE",
  cost: "VARIANT_COST",
  sku: "VARIANT_SKU",
  barcode: "VARIANT_BARCODE",
  inventory: "VARIANT_INVENTORY",
  title: "PRODUCT_TITLE",
  description: "PRODUCT_DESCRIPTION",
  descriptionHtml: "PRODUCT_DESCRIPTION",
  vendor: "PRODUCT_VENDOR",
  productType: "PRODUCT_TYPE",
  status: "PRODUCT_STATUS",
  tags: "PRODUCT_TAGS",
});

const CANONICAL_OPERATION_BY_LABEL = Object.freeze({
  "Set to fixed value": "SET_FIXED",
  "Changed by fixed amount": "INCREASE_FIXED",
  "Increase by percent": "INCREASE_PERCENT",
  "Decrease by percent": "DECREASE_PERCENT",
  "Set to percentage of compare-at-price": "PERCENT_OF_COMPARE_AT_PRICE",
});

function buildRecurringServiceError(code, message = code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function resolveCanonicalField(field) {
  const key = String(field || "").trim();
  return CANONICAL_FIELD_BY_UI_FIELD[key] || key.toUpperCase();
}

function resolveCanonicalOperation(operation, editOption) {
  const explicit = String(operation || "").trim();
  if (explicit) return explicit.toUpperCase();

  const label = String(editOption || "").trim();
  return CANONICAL_OPERATION_BY_LABEL[label] || label.toUpperCase().replace(/\s+/g, "_");
}

function buildValueJson({ operation, value }) {
  const numeric = Number(value);
  const isNumeric = Number.isFinite(numeric);

  if (operation === "INCREASE_PERCENT" || operation === "DECREASE_PERCENT") {
    return {
      type: "percent",
      value: isNumeric ? numeric : value,
    };
  }

  return {
    type: isNumeric ? "number" : "literal",
    value: isNumeric ? numeric : value,
  };
}

function getPreviewFingerprint(previewRecord) {
  return previewRecord?.value && typeof previewRecord.value === "object"
    ? previewRecord.value
    : {};
}

async function resolveTrustedPreviewContract({ shop, body, actor }) {
  const previewContractId = String(body.previewContractId || body.previewId || "").trim();
  if (!previewContractId) {
    throw buildRecurringServiceError(
      "FILTER_CONTRACT_REQUIRED",
      "Run preview again before saving this recurring edit.",
      { field: "previewContractId" },
    );
  }

  const previewRecord = await findPreviewContractRecord(previewContractId, shop);
  if (!previewRecord) {
    throw buildRecurringServiceError(
      "FILTER_CONTRACT_REQUIRED",
      "Run preview again before saving this recurring edit.",
      { field: "previewContractId" },
    );
  }

  if (previewRecord.expiresAt && previewRecord.expiresAt < new Date()) {
    throw buildRecurringServiceError(
      "PREVIEW_STALE",
      "Preview is stale. Run preview again before saving this recurring edit.",
      { field: "previewContractId" },
    );
  }

  const fingerprint = getPreviewFingerprint(previewRecord);
  const previewShop = String(
    previewRecord.shop || fingerprint.shop || fingerprint.owner?.shop || "",
  ).trim();
  if (!previewShop || previewShop !== shop) {
    throw buildRecurringServiceError(
      "FILTER_CONTRACT_REQUIRED",
      "Run preview again before saving this recurring edit.",
      { field: "previewContractId" },
    );
  }

  const previewActorId = String(
    previewRecord.userId ||
      fingerprint.actorId ||
      fingerprint.owner?.actorId ||
      "",
  ).trim();
  const requestActorId = String(actor?.userId || "").trim();
  if (previewActorId && requestActorId && previewActorId !== requestActorId) {
    throw buildRecurringServiceError(
      "PREVIEW_STALE",
      "Preview is stale. Run preview again before saving this recurring edit.",
      { field: "previewContractId" },
    );
  }

  const expectedHash = String(fingerprint.normalizedFilterHash || "").trim();
  const actualHash = String(body.previewFilterHash || "").trim();
  if (expectedHash && actualHash && actualHash !== expectedHash) {
    throw buildRecurringServiceError(
      "PREVIEW_STALE",
      "Preview is stale. Run preview again before saving this recurring edit.",
      { field: "previewFilterHash" },
    );
  }

  const expectedSignature = String(fingerprint.previewSignature || "").trim();
  const actualSignature = String(body.previewSignature || "").trim();
  if (expectedSignature && actualSignature && actualSignature !== expectedSignature) {
    throw buildRecurringServiceError(
      "PREVIEW_STALE",
      "Preview is stale. Run preview again before saving this recurring edit.",
      { field: "previewSignature" },
    );
  }

  const previewCount = Number(fingerprint.targetCount ?? previewRecord.previewResCount);
  if (
    Number.isFinite(previewCount) &&
    body.approvedPreviewCount !== null &&
    body.approvedPreviewCount !== undefined &&
    Number(body.approvedPreviewCount) !== previewCount
  ) {
    throw buildRecurringServiceError(
      "PREVIEW_STALE",
      "Preview count changed. Run preview again before saving this recurring edit.",
      { field: "approvedPreviewCount" },
    );
  }

  return {
    previewContractId,
    previewRecord,
    fingerprint,
    previewCount: Number.isFinite(previewCount) ? previewCount : null,
  };
}

function buildTrustedRecurringBodyFromPreview(body, previewContract) {
  const fingerprint = previewContract.fingerprint;

  return {
    ...body,
    previewContractId: previewContract.previewContractId,
    previewId: previewContract.previewContractId,
    editedField: fingerprint.field || body.editedField || body.field,
    field: fingerprint.field || body.field || body.editedField,
    editedBy: fingerprint.editType || body.editedBy || body.editType,
    editType: fingerprint.editType || body.editType || body.editedBy,
    operation: fingerprint.operation || body.operation,
    value:
      fingerprint.editValue !== undefined
        ? fingerprint.editValue
        : body.value,
    searchKey: fingerprint.searchKey ?? body.searchKey ?? null,
    replaceText: fingerprint.replaceText ?? body.replaceText ?? null,
    supportValue:
      fingerprint.supportValue !== undefined
        ? fingerprint.supportValue
        : body.supportValue,
    locationId: fingerprint.locationId ?? body.locationId ?? null,
    filterFingerprint: fingerprint.normalizedFilterHash || body.filterFingerprint,
    approvedPreviewCount:
      previewContract.previewCount ?? body.approvedPreviewCount ?? null,
  };
}

function normalizeStatus(rawStatus, fallback = "ACTIVE") {
  if (!rawStatus) return fallback;

  const value = String(rawStatus).trim().toUpperCase();
  switch (value) {
    case "ACTIVE":
    case "PAUSED":
    case "COMPLETED":
    case "FAILED":
    case "CANCELLED":
      return value;
    case "INACTIVE":
      return "PAUSED";
    default:
      throw new Error("Unsupported recurring edit status");
  }
}

function buildRulesFromBody(body = {}) {
  if (Array.isArray(body.rules) && body.rules.length > 0) {
    return body.rules;
  }

  if (!body.editedField) {
    throw new Error("rules are required");
  }
  const canonicalOperation = resolveCanonicalOperation(
    body.operation,
    body.editedBy ?? body.editType ?? body.editedType,
  );

  return [
    {
      field: body.editedField,
      canonicalField: resolveCanonicalField(body.editedField),
      value: body.value ?? null,
      editOption: body.editedBy ?? body.editType ?? body.editedType ?? null,
      operation: canonicalOperation,
      valueJson: buildValueJson({
        operation: canonicalOperation,
        value: body.value ?? null,
      }),
      searchKey: body.searchKey ?? null,
      replaceText: body.replaceText ?? null,
      supportValue: body.supportValue ?? null,
      locationId: body.locationId ?? null,
    },
  ];
}

function validateRules(rules = []) {
  if (!Array.isArray(rules) || rules.length !== 1) {
    throw new Error(
      "Recurring edits require exactly one rule in the current bulk edit pipeline",
    );
  }

  const [rule] = rules;
  if (!rule?.field) throw new Error("Recurring edit rule.field is required");
  if (!rule?.editOption) {
    throw new Error("Recurring edit rule.editOption is required");
  }

  return rule;
}

function assertCanonicalRecurringFilterSource({ filterAst, rawFilterInput }) {
  if (filterAst) return;

  if (Array.isArray(rawFilterInput) && rawFilterInput.length > 0) {
    throw new Error(
      "Canonical filterAst is required for recurring edits; legacy rawFilterInput cannot be used as the recurring target source",
    );
  }
}

function buildDefaultTitle(rule) {
  return getUpdatedProducts({
    field: rule.field,
    editType: rule.editOption,
    value: rule.value,
    supportValue: rule.supportValue,
    searchKey: rule.searchKey,
    replaceText: rule.replaceText,
    returnTitleOnly: true,
  });
}

function mapStatusForClient(status) {
  switch (status) {
    case "ACTIVE":
      return "Active";
    case "PAUSED":
      return "Inactive";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Failed";
    case "CANCELLED":
      return "Cancelled";
    default:
      return status;
  }
}

function mapFrequencyForClient(edit) {
  if (edit.scheduleType === "EVERY_X_MINUTES") {
    if (edit.intervalMinutes === 60) return "Hourly";
    if (edit.intervalMinutes === 120) return "Every 2 Hours";
    return "Every X Minutes";
  }

  return edit.scheduleType.toLowerCase().replace(/^\w/, (char) => char.toUpperCase());
}

function indexRunCounts(statusCounts = []) {
  return statusCounts.reduce((accumulator, row) => {
    const current = accumulator[row.recurringEditId] || {
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    };

    current.total += row._count._all;
    if (row.status === "SUCCESS") current.success += row._count._all;
    if (row.status === "FAILED") current.failed += row._count._all;
    if (row.status === "SKIPPED") current.skipped += row._count._all;

    accumulator[row.recurringEditId] = current;
    return accumulator;
  }, {});
}

function indexLatestRuns(runs = []) {
  const latestByRecurringEdit = {};

  for (const run of runs) {
    if (!latestByRecurringEdit[run.recurringEditId]) {
      latestByRecurringEdit[run.recurringEditId] = run;
    }
  }

  return latestByRecurringEdit;
}

function serializeRecurringEdit(edit, countsById = {}, latestRunsById = {}) {
  const counts = countsById[edit.id] || {
    total: edit.runCount || 0,
    success: 0,
    failed: 0,
    skipped: 0,
  };
  const latestRun = latestRunsById[edit.id] || null;

  return {
    id: edit.id,
    shop: edit.shop,
    title: edit.title,
    status: mapStatusForClient(edit.status),
    statusKey: edit.status,
    frequency: mapFrequencyForClient(edit),
    scheduleType: edit.scheduleType,
    timezone: edit.timezone,
    scheduleConfig: edit.scheduleConfig,
    cronExpression: edit.cronExpression,
    intervalMinutes: edit.intervalMinutes,
    timeToRun: edit.scheduleConfig?.time ?? null,
    dayOfMonthToRun: edit.scheduleConfig?.dayOfMonth ?? null,
    daysOfWeekToRun: Array.isArray(edit.scheduleConfig?.weekdays)
      ? edit.scheduleConfig.weekdays.map(
          (weekday) => WEEKDAY_NAMES[weekday] ?? String(weekday),
        )
      : [],
    totalRuns: counts.total,
    successfulRuns: counts.success,
    totalRunsSucceed: counts.success,
    totalRunsSkipped: counts.skipped,
    totalFails: counts.failed,
    runCount: edit.runCount,
    nextRun: edit.nextRunAt,
    nextRunAt: edit.nextRunAt,
    lastRunAt: edit.lastRunAt,
    lastSuccessAt: edit.lastSuccessAt,
    lastFailureAt: edit.lastFailureAt,
    lastFailureReason: edit.lastFailureReason,
    lastRunStatus: latestRun?.status ?? null,
    lastRunMessage: latestRun?.errorMessage ?? edit.lastFailureReason ?? null,
    rules: edit.rules,
    steps: edit.rules,
    rawFilterInput: edit.rawFilterInput,
    filterAst: edit.filterAst ?? null,
    normalizedFilterAst: edit.normalizedFilterAst ?? null,
    targetingSnapshotMeta: edit.targetingSnapshotMeta ?? null,
    operationKey:
      edit?.targetingSnapshotMeta?.operationKey ||
      null,
    legacyQueryFilter: JSON.stringify(
      edit.normalizedFilterAst ?? edit.filterAst ?? edit.rawFilterInput ?? [],
    ),
    startAt: edit.startAt,
    endAt: edit.endAt,
    createdAt: edit.createdAt,
    updatedAt: edit.updatedAt,
  };
}

function serializeRecurringEditListItem(edit, countsById = {}, latestRunsById = {}) {
  const full = serializeRecurringEdit(edit, countsById, latestRunsById);
  const normalizedStatusKey = String(full.statusKey || "").trim().toLowerCase();
  const normalizedFrequencyKey = String(full.frequency || "").trim().toLowerCase();
  return {
    id: full.id,
    title: full.title,
    status: full.status,
    statusKey: full.statusKey,
    frequency: full.frequency,
    totalRuns: full.totalRuns,
    successfulRuns: full.successfulRuns,
    totalFails: full.totalFails,
    createdAt: full.createdAt,
    nextRunAt: full.nextRunAt,
    lastRunAt: full.lastRunAt,
    lastRunStatus: full.lastRunStatus,
    statusSummary: {
      key: normalizedStatusKey || "unknown",
      labelKey: `statusRecurring.${normalizedStatusKey || "unknown"}`,
      defaultLabel: full.status || "Unknown",
    },
    frequencySummary: {
      key: normalizedFrequencyKey || "unknown",
      labelKey: `frequencyRecurring.${normalizedFrequencyKey || "unknown"}`,
      defaultLabel: full.frequency || "-",
    },
  };
}

async function getRecurringEditHydrated(id, shop) {
  const edit = await recurringEditRepository.findByIdForShop(id, shop);
  if (!edit) {
    throw new Error("Recurring edit not found");
  }

  const [statusCounts, latestRuns] = await Promise.all([
    recurringEditRunRepository.groupStatusCounts([edit.id]),
    recurringEditRunRepository.findLatestRuns([edit.id]),
  ]);

  const countsById = indexRunCounts(statusCounts);
  const latestRunsById = indexLatestRuns(latestRuns);
  const serialized = serializeRecurringEdit(edit, countsById, latestRunsById);

  const previewTarget = await TargetingEngineService.resolvePreviewTargets({
    shop,
    source: "RECURRING",
    targetResourceType: "PRODUCT",
    targetGranularity: "PRODUCT",
    filterAst: edit.filterAst ?? null,
    legacyFilterParams: Array.isArray(edit.rawFilterInput) ? edit.rawFilterInput : [],
    queryParams: { cursor: null, limit: 1 },
    sampleLimit: 1,
  });
  const latestHistory = latestRunsById[edit.id]?.editHistoryId
    ? await db.editHistory.findUnique({
        where: { id: latestRunsById[edit.id].editHistoryId },
        select: {
          processedCount: true,
          totalItems: true,
          durationMs: true,
        },
      })
    : null;

  return {
    ...serialized,
    totalItems: latestHistory?.totalItems ?? previewTarget.count,
    processedCount: latestHistory?.processedCount ?? 0,
    durationMs: latestHistory?.durationMs ?? 0,
  };
}

export async function createRecurringEdit({ shop, body, actor = null, subscription }) {
  await assertPaidRecurringEditAccess(subscription);

  const previewContract = await resolveTrustedPreviewContract({ shop, body, actor });
  const trustedBody = buildTrustedRecurringBodyFromPreview(body, previewContract);
  const rawFilterInput = Array.isArray(trustedBody.rawFilterInput) ? trustedBody.rawFilterInput : [];
  assertCanonicalRecurringFilterSource({
    filterAst: trustedBody.filterAst ?? null,
    rawFilterInput,
  });
  const rawFilterInputToPersist = [];
  const rules = buildRulesFromBody(trustedBody);
  const rule = validateRules(rules);
  const status = normalizeStatus(trustedBody.status, "ACTIVE");

  if (status === "ACTIVE") {
    await assertRecurringEditActiveLimit({ shop });
  }

  const scheduleInput = buildRecurringScheduleInput(trustedBody);
  const title = String(body.title || "").trim() || buildDefaultTitle(rule);
  const nextRunAt = status === "ACTIVE"
    ? computeRecurringEditNextRunAt({ ...scheduleInput, status }, scheduleInput.startAt || new Date())
    : null;
  const targetingPayload = TargetingEngineService.prepareTargetingPayload({
    filterAst: trustedBody.filterAst ?? null,
    legacyFilterParams: [],
    targetGranularity: "PRODUCT",
    source: "RECURRING",
    applyMirrorScope: false,
  });
  const recurringExecutionPlan = planMutationExecution({
    operationKey: trustedBody.operationKey || null,
    shop,
    planType: "RECURRING_EDIT",
    mutationIntent: {
      mutationType: "PRODUCT_SET",
      fieldsBeingEdited: rules.map((item) => item?.field).filter(Boolean),
      operationKey: trustedBody.operationKey || null,
    },
    targetGranularity: targetingPayload.targetGranularity || "PRODUCT",
    targetCount: 0,
    fieldsBeingEdited: rules.map((item) => item?.field).filter(Boolean),
    shopPlanLimits: { batchSize: 250 },
  });
  const targetingSnapshotMeta = {
    operationKey: recurringExecutionPlan.operationKey,
    createdCompilerVersion: targetingPayload.versions.targetingCompilerVersion,
    currentCompilerVersion: targetingPayload.versions.targetingCompilerVersion,
    astVersion: targetingPayload.versions.filterAstVersion,
    compilerVersion: targetingPayload.versions.targetingCompilerVersion,
    fieldRegistryVersion: targetingPayload.versions.fieldRegistryVersion,
    operatorRegistryVersion: targetingPayload.versions.operatorRegistryVersion,
    targetGranularity: targetingPayload.targetGranularity,
    shop,
    mirrorBatchId: null,
    approvedPreviewCount:
      Number.isInteger(trustedBody.approvedPreviewCount) && trustedBody.approvedPreviewCount >= 0
        ? trustedBody.approvedPreviewCount
        : null,
    targetCount: previewContract.previewCount,
    normalizedFilterHash: targetingPayload.normalizedFilterHash,
    filterFingerprint:
      String(trustedBody.filterFingerprint || trustedBody.targetDefinitionHash || "").trim() ||
      targetingPayload.normalizedFilterHash,
    frontendTargetingFingerprint:
      String(trustedBody.targetDefinitionHash || "").trim() || null,
    filterContractId: previewContract.previewContractId,
    previewContractId: previewContract.previewContractId,
    previewSignature:
      String(trustedBody.previewSignature || previewContract.fingerprint.previewSignature || "").trim() ||
      null,
    normalizedAst: targetingPayload.normalizedFilterAst,
    source: "RECURRING",
    semantics: "DYNAMIC_AT_RUN",
    resolvedAt: null,
  };

  const created = await recurringEditRepository.create({
    shop,
    title,
    status,
    scheduleType: scheduleInput.scheduleType,
    timezone: scheduleInput.timezone,
    scheduleConfig: scheduleInput.scheduleConfig,
    cronExpression: scheduleInput.cronExpression,
    intervalMinutes: scheduleInput.intervalMinutes,
    startAt: scheduleInput.startAt,
    endAt: scheduleInput.endAt,
    rawFilterInput: rawFilterInputToPersist,
    filterAst: targetingPayload.filterAst,
    normalizedFilterAst: targetingPayload.normalizedFilterAst,
    targetingSnapshotMeta,
    targetFreezeMode: "DYNAMIC_AT_RUN",
    targetGranularity: targetingPayload.targetGranularity,
    targetingCompilerVersion: targetingPayload.versions.targetingCompilerVersion,
    fieldRegistryVersion: targetingPayload.versions.fieldRegistryVersion,
    operatorRegistryVersion: targetingPayload.versions.operatorRegistryVersion,
    normalizedFilterHash: targetingPayload.normalizedFilterHash,
    actorType: actor?.type || null,
    actorId: actor?.userId || null,
    actorEmail: actor?.email || null,
    actorDisplayName: actor?.name || null,
    rules,
    nextRunAt,
  });

  logger.info("Recurring edit created", {
    shop,
    recurringEditId: created.id,
    scheduleType: created.scheduleType,
    nextRunAt: created.nextRunAt,
  });

  return getRecurringEditHydrated(created.id, shop);
}

export async function listRecurringEdits({
  shop,
  cursor = null,
  limit = 20,
  search = "",
  status = "",
  frequency = "",
}) {
  const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const normalizedFrequency = String(frequency || "").trim().toLowerCase();
  let cursorFilter = {};
  if (cursor) {
    const cursorRow = await recurringEditRepository.findByIdForShop(cursor, shop);
    if (cursorRow) {
      cursorFilter = {
        OR: [
          { createdAt: { lt: cursorRow.createdAt } },
          { AND: [{ createdAt: cursorRow.createdAt }, { id: { lt: cursorRow.id } }] },
        ],
      };
    }
  }

  const where = {
    ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
    ...(status
      ? {
          status: String(status).trim().toUpperCase() === "INACTIVE"
            ? "PAUSED"
            : String(status).trim().toUpperCase(),
        }
      : {}),
    ...(normalizedFrequency
      ? normalizedFrequency === "hourly"
        ? { scheduleType: "EVERY_X_MINUTES", intervalMinutes: 60 }
        : normalizedFrequency === "every 2 hours"
          ? { scheduleType: "EVERY_X_MINUTES", intervalMinutes: 120 }
          : { scheduleType: normalizedFrequency.toUpperCase() }
      : {}),
    ...(Object.keys(cursorFilter).length ? cursorFilter : {}),
  };
  const countWhere = {
    shop,
    isDeleted: false,
    ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
    ...(status
      ? {
          status: String(status).trim().toUpperCase() === "INACTIVE"
            ? "PAUSED"
            : String(status).trim().toUpperCase(),
        }
      : {}),
    ...(normalizedFrequency
      ? normalizedFrequency === "hourly"
        ? { scheduleType: "EVERY_X_MINUTES", intervalMinutes: 60 }
        : normalizedFrequency === "every 2 hours"
          ? { scheduleType: "EVERY_X_MINUTES", intervalMinutes: 120 }
          : { scheduleType: normalizedFrequency.toUpperCase() }
      : {}),
  };

  const [edits, totalCount] = await Promise.all([
    recurringEditRepository.listByShop(
      shop,
      {
        where,
        take: normalizedLimit + 1,
      },
    ),
    db.recurringEdit.count({ where: countWhere }),
  ]);

  const hasNextPage = edits.length > normalizedLimit;
  const pageItems = hasNextPage ? edits.slice(0, normalizedLimit) : edits;
  const endCursor = pageItems.length ? pageItems[pageItems.length - 1].id : null;
  const ids = pageItems.map((edit) => edit.id);
  const [statusCounts, latestRuns] = await Promise.all([
    recurringEditRunRepository.groupStatusCounts(ids),
    recurringEditRunRepository.findLatestRuns(ids),
  ]);

  const countsById = indexRunCounts(statusCounts);
  const latestRunsById = indexLatestRuns(latestRuns);

  return {
    items: pageItems.map((edit) =>
      serializeRecurringEditListItem(edit, countsById, latestRunsById),
    ),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: Boolean(cursor),
      nextCursor: hasNextPage ? endCursor : null,
      previousCursor: null,
      endCursor,
    },
    totalCount,
  };
}

export async function getRecurringEditById({ shop, recurringEditId }) {
  return getRecurringEditHydrated(recurringEditId, shop);
}

export async function updateRecurringEdit({
  shop,
  recurringEditId,
  body,
  subscription,
}) {
  const existing = await recurringEditRepository.findByIdForShop(recurringEditId, shop);
  if (!existing) {
    throw new Error("Recurring edit not found");
  }

  const mergedBody = {
    ...body,
    scheduleType: body.scheduleType ?? body.frequency ?? existing.scheduleType,
    timezone: body.timezone ?? existing.timezone,
    startAt: body.startAt ?? existing.startAt,
    endAt: body.endAt ?? existing.endAt,
    scheduleConfig: body.scheduleConfig ?? existing.scheduleConfig,
    intervalMinutes: body.intervalMinutes ?? existing.intervalMinutes,
    cronExpression: body.cronExpression ?? existing.cronExpression,
  };

  const nextStatus = normalizeStatus(body.status, existing.status);
  if (nextStatus === "ACTIVE") {
    await assertPaidRecurringEditAccess(subscription);
    if (existing.status !== "ACTIVE") {
      await assertRecurringEditActiveLimit({
        shop,
        excludeRecurringEditId: existing.id,
      });
    }
  }

  const scheduleInput = buildRecurringScheduleInput(mergedBody, existing);
  const rules = body.rules ? buildRulesFromBody(body) : existing.rules;
  const rule = validateRules(rules);
  const rawFilterInput = Array.isArray(body.rawFilterInput) ? body.rawFilterInput : existing.rawFilterInput;
  const filterAst = body.filterAst ?? existing.filterAst ?? null;
  assertCanonicalRecurringFilterSource({
    filterAst,
    rawFilterInput,
  });
  const rawFilterInputToPersist = [];
  const title = body.title !== undefined
    ? String(body.title || "").trim() || buildDefaultTitle(rule)
    : existing.title;
  const nextRunAt = nextStatus === "ACTIVE"
    ? computeRecurringEditNextRunAt({ ...existing, ...scheduleInput, status: nextStatus }, new Date())
    : null;
  const targetingPayload = TargetingEngineService.prepareTargetingPayload({
    filterAst,
    legacyFilterParams: [],
    targetGranularity: body.targetGranularity ?? existing.targetGranularity ?? "PRODUCT",
    source: "RECURRING",
    applyMirrorScope: false,
  });
  const recurringExecutionPlan = planMutationExecution({
    operationKey:
      body.operationKey ||
      existing?.targetingSnapshotMeta?.operationKey ||
      null,
    shop,
    planType: "RECURRING_EDIT",
    mutationIntent: {
      mutationType: "PRODUCT_SET",
      fieldsBeingEdited: rules.map((item) => item?.field).filter(Boolean),
      operationKey:
        body.operationKey ||
        existing?.targetingSnapshotMeta?.operationKey ||
        null,
    },
    targetGranularity: targetingPayload.targetGranularity || "PRODUCT",
    targetCount: 0,
    fieldsBeingEdited: rules.map((item) => item?.field).filter(Boolean),
    shopPlanLimits: { batchSize: 250 },
  });
  const targetingSnapshotMeta = {
    operationKey: recurringExecutionPlan.operationKey,
    createdCompilerVersion: targetingPayload.versions.targetingCompilerVersion,
    currentCompilerVersion: targetingPayload.versions.targetingCompilerVersion,
    astVersion: targetingPayload.versions.filterAstVersion,
    compilerVersion: targetingPayload.versions.targetingCompilerVersion,
    fieldRegistryVersion: targetingPayload.versions.fieldRegistryVersion,
    operatorRegistryVersion: targetingPayload.versions.operatorRegistryVersion,
    targetGranularity: targetingPayload.targetGranularity,
    shop,
    mirrorBatchId: null,
    approvedPreviewCount:
      Number.isInteger(body.approvedPreviewCount) && body.approvedPreviewCount >= 0
        ? body.approvedPreviewCount
        : existing?.targetingSnapshotMeta?.approvedPreviewCount ?? null,
    targetCount: null,
    normalizedFilterHash: targetingPayload.normalizedFilterHash,
    filterFingerprint:
      String(body.filterFingerprint || body.targetDefinitionHash || "").trim() ||
      targetingPayload.normalizedFilterHash,
    frontendTargetingFingerprint:
      String(body.targetDefinitionHash || "").trim() ||
      existing?.targetingSnapshotMeta?.frontendTargetingFingerprint ||
      null,
    normalizedAst: targetingPayload.normalizedFilterAst,
    source: "RECURRING",
    semantics: "DYNAMIC_AT_RUN",
    resolvedAt: null,
  };

  await recurringEditRepository.updateByIdForShop({
    id: existing.id,
    shop,
    expectedRevision: existing.revision,
    data: {
    title,
    status: nextStatus,
    scheduleType: scheduleInput.scheduleType,
    timezone: scheduleInput.timezone,
    scheduleConfig: scheduleInput.scheduleConfig,
    cronExpression: scheduleInput.cronExpression,
    intervalMinutes: scheduleInput.intervalMinutes,
    startAt: scheduleInput.startAt,
    endAt: scheduleInput.endAt,
    rawFilterInput: rawFilterInputToPersist,
    filterAst: targetingPayload.filterAst,
    normalizedFilterAst: targetingPayload.normalizedFilterAst,
    targetingSnapshotMeta,
    targetFreezeMode: "DYNAMIC_AT_RUN",
    targetGranularity: targetingPayload.targetGranularity,
    targetingCompilerVersion: targetingPayload.versions.targetingCompilerVersion,
    fieldRegistryVersion: targetingPayload.versions.fieldRegistryVersion,
    operatorRegistryVersion: targetingPayload.versions.operatorRegistryVersion,
    normalizedFilterHash: targetingPayload.normalizedFilterHash,
    rules,
    nextRunAt,
    isDeleted: false,
    },
  });

  return getRecurringEditHydrated(existing.id, shop);
}

export async function toggleRecurringEditStatus({
  shop,
  recurringEditId,
  status,
  subscription,
}) {
  const existing = await recurringEditRepository.findByIdForShop(recurringEditId, shop);
  if (!existing) {
    throw new Error("Recurring edit not found");
  }

  const requestedStatus = normalizeStatus(
    status,
    existing.status === "ACTIVE" ? "PAUSED" : "ACTIVE",
  );

  if (requestedStatus === "ACTIVE") {
    await assertPaidRecurringEditAccess(subscription);
    await assertRecurringEditActiveLimit({
      shop,
      excludeRecurringEditId: existing.id,
    });
  }

  const nextRunAt = requestedStatus === "ACTIVE"
    ? computeRecurringEditNextRunAt(existing, new Date())
    : null;

  await recurringEditRepository.updateByIdForShop({
    id: existing.id,
    shop,
    data: {
      status: requestedStatus,
      nextRunAt,
    },
  });

  return getRecurringEditHydrated(existing.id, shop);
}

export async function deleteRecurringEdit({ shop, recurringEditId }) {
  const existing = await recurringEditRepository.findByIdForShop(recurringEditId, shop);
  if (!existing) {
    throw new Error("Recurring edit not found");
  }

  await recurringEditRepository.updateByIdForShop({
    id: existing.id,
    shop,
    data: {
      status: "CANCELLED",
      isDeleted: true,
      nextRunAt: null,
      endAt: existing.endAt || new Date(),
    },
  });

  return {
    id: existing.id,
    deleted: true,
  };
}
