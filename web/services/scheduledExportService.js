import { scheduledExportRepository } from "../repositories/scheduledExportRepository.js";
import { scheduledExportRunRepository } from "../repositories/scheduledExportRunRepository.js";
import { assertScheduledExportAccess } from "./scheduledExportPlanService.js";
import {
  buildScheduledExportScheduleInput,
  computeScheduledExportNextRunAt,
} from "./scheduledExportScheduleService.js";
import logger from "../utils/loggerUtils.js";
import { TargetingEngineService } from "./targeting/TargetingEngineService.js";

function buildScheduledExportError(message, statusCode = 400, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
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
      throw buildScheduledExportError("Unsupported scheduled export status");
  }
}

function normalizeFilename(filename) {
  const value = String(filename || "").trim();
  if (!value) {
    throw buildScheduledExportError("filename is required");
  }

  return value.endsWith(".csv") ? value : `${value}.csv`;
}

function validateFields(fields = []) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw buildScheduledExportError("fields are required");
  }

  return Array.from(
    new Set(fields.map((field) => String(field).trim()).filter(Boolean)),
  );
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

function mapFrequencyForClient(item) {
  if (item.scheduleType === "ONE_TIME") {
    return "Once";
  }

  if (item.scheduleType === "EVERY_X_MINUTES") {
    if (item.intervalMinutes === 60) return "Hourly";
    if (item.intervalMinutes === 120) return "Every 2 Hours";
    return "Every X Minutes";
  }

  return item.scheduleType.toLowerCase().replace(/^\w/, (char) => char.toUpperCase());
}

function indexRunCounts(statusCounts = []) {
  return statusCounts.reduce((accumulator, row) => {
    const current = accumulator[row.scheduledExportId] || {
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    };

    current.total += row._count._all;
    if (row.status === "SUCCESS") current.success += row._count._all;
    if (row.status === "FAILED") current.failed += row._count._all;
    if (row.status === "SKIPPED") current.skipped += row._count._all;

    accumulator[row.scheduledExportId] = current;
    return accumulator;
  }, {});
}

function indexLatestRuns(runs = []) {
  const latestByScheduledExport = {};

  for (const run of runs) {
    if (!latestByScheduledExport[run.scheduledExportId]) {
      latestByScheduledExport[run.scheduledExportId] = run;
    }
  }

  return latestByScheduledExport;
}

function serializeScheduledExport(item, countsById = {}, latestRunsById = {}) {
  const counts = countsById[item.id] || {
    total: item.runCount || 0,
    success: 0,
    failed: 0,
    skipped: 0,
  };
  const latestRun = latestRunsById[item.id] || null;

  return {
    _id: item.id,
    id: item.id,
    shop: item.shop,
    title: item.title,
    status: mapStatusForClient(item.status),
    statusKey: item.status,
    frequency: mapFrequencyForClient(item),
    scheduleType: item.scheduleType,
    timezone: item.timezone,
    scheduleConfig: item.scheduleConfig,
    cronExpression: item.cronExpression,
    intervalMinutes: item.intervalMinutes,
    fields: item.fields,
    filename: item.filename,
    filterParams: item.filterParams,
    filterAst: item.filterAst ?? null,
    normalizedFilterAst: item.normalizedFilterAst ?? null,
    targetingSnapshotMeta: item.targetingSnapshotMeta ?? null,
    totalRuns: counts.total,
    successfulRuns: counts.success,
    totalRunsSucceed: counts.success,
    totalRunsSkipped: counts.skipped,
    totalFails: counts.failed,
    runCount: item.runCount,
    nextRun: item.nextRunAt,
    nextRunAt: item.nextRunAt,
    lastRunAt: item.lastRunAt,
    lastSuccessAt: item.lastSuccessAt,
    lastFailureAt: item.lastFailureAt,
    lastFailureReason: item.lastFailureReason,
    lastRunStatus: latestRun?.status ?? null,
    lastRunMessage: latestRun?.errorMessage ?? item.lastFailureReason ?? null,
    lastFileUrl: latestRun?.fileUrl ?? null,
    startAt: item.startAt,
    endAt: item.endAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function getScheduledExportHydrated(id, shop) {
  const scheduledExport = await scheduledExportRepository.findByIdForShop(id, shop);
  if (!scheduledExport) {
    throw buildScheduledExportError("Scheduled export not found", 404, "NOT_FOUND");
  }

  const [statusCounts, latestRuns] = await Promise.all([
    scheduledExportRunRepository.groupStatusCounts(shop, [scheduledExport.id]),
    scheduledExportRunRepository.findLatestRuns(shop, [scheduledExport.id]),
  ]);

  return serializeScheduledExport(
    scheduledExport,
    indexRunCounts(statusCounts),
    indexLatestRuns(latestRuns),
  );
}

export async function createScheduledExport({ shop, scheduledExport, subscription }) {
  await assertScheduledExportAccess(subscription);

  const input = scheduledExport || {};
  const fields = validateFields(input.fields);
  const filename = normalizeFilename(input.filename ?? input.fileName);
  const filterParams = Array.isArray(input.filterParams) ? input.filterParams : [];
  const filterParamsToPersist = [];
  const status = normalizeStatus(input.status, "ACTIVE");
  const scheduleInput = buildScheduledExportScheduleInput({
    ...input,
  });
  const title = String(input.title || "").trim() || filename.replace(/\.csv$/i, "");
  const nextRunAt =
    status === "ACTIVE"
      ? computeScheduledExportNextRunAt(
          { ...scheduleInput, status, endAt: scheduleInput.endAt },
          new Date(),
        )
      : null;
  const targetingPayload = TargetingEngineService.prepareTargetingPayload({
    filterAst: input.filterAst ?? null,
    legacyFilterParams: filterParams,
    targetGranularity: "PRODUCT",
    source: "EXPORT",
    applyMirrorScope: false,
  });
  const targetingSnapshotMeta = {
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
    source: "EXPORT",
    semantics: "DYNAMIC_AT_RUN",
    resolvedAt: null,
  };

  if (status === "ACTIVE" && !nextRunAt) {
  console.error("❌ nextRunAt is NULL during creation");
  throw buildScheduledExportError("Scheduled export time must be in the future");
}

  const created = await scheduledExportRepository.create({
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
    fields,
    filename,
    nextRunAt,
  });
console.log("🧪 Creating scheduled export:", {
  status,
  nextRunAt,
  now: new Date().toISOString(),
});

  logger.info("Scheduled export created", {
    shop,
    scheduledExportId: created.id,
    nextRunAt: created.nextRunAt,
  });

  return getScheduledExportHydrated(created.id, shop);
}

export async function listScheduledExports({ shop }) {
  const items = await scheduledExportRepository.listByShop(shop);
  const ids = items.map((item) => item.id);
  const [statusCounts, latestRuns] = await Promise.all([
    scheduledExportRunRepository.groupStatusCounts(shop, ids),
    scheduledExportRunRepository.findLatestRuns(shop, ids),
  ]);

  const countsById = indexRunCounts(statusCounts);
  const latestRunsById = indexLatestRuns(latestRuns);

  return items.map((item) => serializeScheduledExport(item, countsById, latestRunsById));
}

export async function getScheduledExportById({ shop, scheduledExportId }) {
  return getScheduledExportHydrated(scheduledExportId, shop);
}

export async function updateScheduledExport({
  shop,
  scheduledExportId,
  scheduledExport,
  subscription,
}) {
  const existing = await scheduledExportRepository.findByIdForShop(scheduledExportId, shop);
  if (!existing) {
    throw buildScheduledExportError("Scheduled export not found", 404, "NOT_FOUND");
  }

  const input = scheduledExport || {};
  const nextStatus = normalizeStatus(input.status, existing.status);
  if (nextStatus === "ACTIVE") {
    await assertScheduledExportAccess(subscription);
  }

  const scheduleInput = buildScheduledExportScheduleInput(
    {
      ...input,
      timezone: input.timezone ?? existing.timezone ?? "UTC",
      startAt: input.startAt ?? existing.startAt,
      endAt: input.endAt ?? existing.endAt,
      scheduleConfig: input.scheduleConfig ?? existing.scheduleConfig,
      intervalMinutes: input.intervalMinutes ?? existing.intervalMinutes,
      cronExpression: input.cronExpression ?? existing.cronExpression,
    },
    existing,
  );

  const fields = input.fields ? validateFields(input.fields) : existing.fields;
  const filename =
    input.filename !== undefined || input.fileName !== undefined
      ? normalizeFilename(input.filename ?? input.fileName)
      : existing.filename;
  const filterParams = Array.isArray(input.filterParams)
    ? input.filterParams
    : existing.filterParams;
  const filterParamsToPersist = [];
  const title =
    input.title !== undefined
      ? String(input.title || "").trim() || filename.replace(/\.csv$/i, "")
      : existing.title;
  const nextRunAt =
    nextStatus === "ACTIVE"
      ? computeScheduledExportNextRunAt(
          {
            ...existing,
            ...scheduleInput,
            status: nextStatus,
            endAt: scheduleInput.endAt,
          },
          new Date(),
        )
      : null;
  const targetingPayload = TargetingEngineService.prepareTargetingPayload({
    filterAst: input.filterAst ?? existing.filterAst ?? null,
    legacyFilterParams: input.filterAst ? null : filterParams,
    targetGranularity: input.targetGranularity ?? existing.targetGranularity ?? "PRODUCT",
    source: "EXPORT",
    applyMirrorScope: false,
  });
  const targetingSnapshotMeta = {
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
    source: "EXPORT",
    semantics: "DYNAMIC_AT_RUN",
    resolvedAt: null,
  };

  if (nextStatus === "ACTIVE" && !nextRunAt) {
    throw buildScheduledExportError("Scheduled export time must be in the future");
  }

  await scheduledExportRepository.updateByIdForShop({
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
    fields,
    filename,
    nextRunAt,
    isDeleted: false,
    },
  });

  return getScheduledExportHydrated(existing.id, shop);
}

export async function toggleScheduledExportStatus({
  shop,
  scheduledExportId,
  status,
  subscription,
}) {
  const existing = await scheduledExportRepository.findByIdForShop(scheduledExportId, shop);
  if (!existing) {
    throw buildScheduledExportError("Scheduled export not found", 404, "NOT_FOUND");
  }

  const requestedStatus = normalizeStatus(
    status,
    existing.status === "ACTIVE" ? "PAUSED" : "ACTIVE",
  );

  if (requestedStatus === "ACTIVE") {
    await assertScheduledExportAccess(subscription);
  }

  const nextRunAt =
    requestedStatus === "ACTIVE"
      ? computeScheduledExportNextRunAt(existing, new Date())
      : null;

  if (requestedStatus === "ACTIVE" && !nextRunAt) {
    throw buildScheduledExportError("Scheduled export time must be in the future");
  }

  await scheduledExportRepository.updateByIdForShop({
    id: existing.id,
    shop,
    data: {
      status: requestedStatus,
      nextRunAt,
    },
  });

  return getScheduledExportHydrated(existing.id, shop);
}

export async function deleteScheduledExport({ shop, scheduledExportId }) {
  const existing = await scheduledExportRepository.findByIdForShop(scheduledExportId, shop);
  if (!existing) {
    throw buildScheduledExportError("Scheduled export not found", 404, "NOT_FOUND");
  }

  await scheduledExportRepository.updateByIdForShop({
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
