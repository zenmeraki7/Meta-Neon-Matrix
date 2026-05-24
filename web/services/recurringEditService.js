import { prisma } from "../config/database.js";
import { getUpdatedProducts } from "../helpers/productBulkOperationHelpers/productUpdateHandler.js";
import { recurringEditRepository } from "../repositories/recurringEditRepository.js";
import { recurringEditRunRepository } from "../repositories/recurringEditRunRepository.js";
import {
  assertProRecurringEditAccess,
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

  return [
    {
      field: body.editedField,
      value: body.value ?? null,
      editOption: body.editedBy ?? body.editType ?? body.editedType ?? null,
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
    _id: edit.id,
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
    filterParams: edit.filterParams,
    filterAst: edit.filterAst ?? null,
    normalizedFilterAst: edit.normalizedFilterAst ?? null,
    targetingSnapshotMeta: edit.targetingSnapshotMeta ?? null,
    operationKey:
      edit?.targetingSnapshotMeta?.operationKey ||
      null,
    queryFilter: JSON.stringify(
      edit.normalizedFilterAst ?? edit.filterAst ?? edit.filterParams ?? [],
    ),
    startAt: edit.startAt,
    endAt: edit.endAt,
    createdAt: edit.createdAt,
    updatedAt: edit.updatedAt,
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
    targetType: "PRODUCT",
    targetGranularity: "PRODUCT",
    filterAst: edit.filterAst ?? null,
    legacyFilterParams: Array.isArray(edit.filterParams) ? edit.filterParams : [],
    queryParams: { cursor: null, limit: 1 },
    sampleLimit: 1,
  });
  const latestHistory = latestRunsById[edit.id]?.editHistoryId
    ? await prisma.editHistory.findUnique({
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

export async function createRecurringEdit({ shop, body, subscription }) {
  await assertProRecurringEditAccess(subscription);

  const filterParams = Array.isArray(body.filterParams) ? body.filterParams : [];
  const filterParamsToPersist = [];
  const rules = buildRulesFromBody(body);
  const rule = validateRules(rules);
  const status = normalizeStatus(body.status, "ACTIVE");

  if (status === "ACTIVE") {
    await assertRecurringEditActiveLimit({ shop });
  }

  const scheduleInput = buildRecurringScheduleInput(body);
  const title = String(body.title || "").trim() || buildDefaultTitle(rule);
  const nextRunAt = status === "ACTIVE"
    ? computeRecurringEditNextRunAt({ ...scheduleInput, status }, scheduleInput.startAt || new Date())
    : null;
  const targetingPayload = TargetingEngineService.prepareTargetingPayload({
    filterAst: body.filterAst ?? null,
    legacyFilterParams: filterParams,
    targetGranularity: "PRODUCT",
    source: "RECURRING",
    applyMirrorScope: false,
  });
  const recurringExecutionPlan = planMutationExecution({
    operationKey: body.operationKey || null,
    shop,
    planType: "RECURRING_EDIT",
    mutationIntent: {
      mutationType: "PRODUCT_SET",
      fieldsBeingEdited: rules.map((item) => item?.field).filter(Boolean),
      operationKey: body.operationKey || null,
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
    targetCount: null,
    filterHash: targetingPayload.filterHash,
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
    filterParams: filterParamsToPersist,
    filterAst: targetingPayload.filterAst,
    normalizedFilterAst: targetingPayload.normalizedFilterAst,
    targetingSnapshotMeta,
    targetingMode: "DYNAMIC_AT_RUN",
    targetGranularity: targetingPayload.targetGranularity,
    targetingCompilerVersion: targetingPayload.versions.targetingCompilerVersion,
    fieldRegistryVersion: targetingPayload.versions.fieldRegistryVersion,
    operatorRegistryVersion: targetingPayload.versions.operatorRegistryVersion,
    filterHash: targetingPayload.filterHash,
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

export async function listRecurringEdits({ shop }) {
  const edits = await recurringEditRepository.listByShop(shop);
  const ids = edits.map((edit) => edit.id);
  const [statusCounts, latestRuns] = await Promise.all([
    recurringEditRunRepository.groupStatusCounts(ids),
    recurringEditRunRepository.findLatestRuns(ids),
  ]);

  const countsById = indexRunCounts(statusCounts);
  const latestRunsById = indexLatestRuns(latestRuns);

  return edits.map((edit) => serializeRecurringEdit(edit, countsById, latestRunsById));
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
    await assertProRecurringEditAccess(subscription);
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
  const filterParams = Array.isArray(body.filterParams) ? body.filterParams : existing.filterParams;
  const filterParamsToPersist = [];
  const title = body.title !== undefined
    ? String(body.title || "").trim() || buildDefaultTitle(rule)
    : existing.title;
  const nextRunAt = nextStatus === "ACTIVE"
    ? computeRecurringEditNextRunAt({ ...existing, ...scheduleInput, status: nextStatus }, new Date())
    : null;
  const targetingPayload = TargetingEngineService.prepareTargetingPayload({
    filterAst: body.filterAst ?? existing.filterAst ?? null,
    legacyFilterParams: body.filterAst ? null : filterParams,
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
    targetCount: null,
    filterHash: targetingPayload.filterHash,
    normalizedAst: targetingPayload.normalizedFilterAst,
    source: "RECURRING",
    semantics: "DYNAMIC_AT_RUN",
    resolvedAt: null,
  };

  await recurringEditRepository.updateByIdForShop({
    id: existing.id,
    shop,
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
    filterParams: filterParamsToPersist,
    filterAst: targetingPayload.filterAst,
    normalizedFilterAst: targetingPayload.normalizedFilterAst,
    targetingSnapshotMeta,
    targetingMode: "DYNAMIC_AT_RUN",
    targetGranularity: targetingPayload.targetGranularity,
    targetingCompilerVersion: targetingPayload.versions.targetingCompilerVersion,
    fieldRegistryVersion: targetingPayload.versions.fieldRegistryVersion,
    operatorRegistryVersion: targetingPayload.versions.operatorRegistryVersion,
    filterHash: targetingPayload.filterHash,
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
    await assertProRecurringEditAccess(subscription);
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
