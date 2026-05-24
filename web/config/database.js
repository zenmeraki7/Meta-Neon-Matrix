// FILE: web/config/database.js adding to github
import { PrismaClient } from "../generated/prisma/index.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
  normalizeExportJobExecutionState,
  normalizeExportJobStatus,
  normalizeWebhookDeliveryStatus,
} from "../utils/normalizedStateUtils.js";
// Ensure a single instance of PrismaClient is used across the application
const globalForPrisma = globalThis;
const LEGACY_COMPAT = Object.freeze({
  whereRewrite: String(process.env.ENABLE_LEGACY_WHERE_REWRITE || "false").toLowerCase() === "true",
});

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

function mapFieldValue(model, field, value) {
  if (model === "EditHistory" && field === "status") {
    if (Array.isArray(value)) return value.map(normalizeEditHistoryStatus);
    return normalizeEditHistoryStatus(value);
  }
  if (model === "EditHistory" && field === "executionState") {
    if (Array.isArray(value)) return value.map(normalizeEditHistoryExecutionState);
    return normalizeEditHistoryExecutionState(value);
  }
  if (model === "ExportJob" && field === "status") {
    if (Array.isArray(value)) return value.map(normalizeExportJobStatus);
    return normalizeExportJobStatus(value);
  }
  if (model === "ExportJob" && field === "executionState") {
    if (Array.isArray(value)) return value.map(normalizeExportJobExecutionState);
    return normalizeExportJobExecutionState(value);
  }
  if (model === "WebhookDelivery" && field === "status") {
    if (Array.isArray(value)) return value.map(normalizeWebhookDeliveryStatus);
    return normalizeWebhookDeliveryStatus(value);
  }
  return value;
}

function rewriteLegacyWhereToNormalized(model, where) {
  if (!where || typeof where !== "object") return where;
  if (Array.isArray(where)) {
    return where.map((item) => rewriteLegacyWhereToNormalized(model, item));
  }

  const out = { ...where };
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (["AND", "OR", "NOT"].includes(key)) {
      out[key] = rewriteLegacyWhereToNormalized(model, value);
      continue;
    }

    if (key === "status") {
      if (!Object.prototype.hasOwnProperty.call(out, "statusNormalized")) {
        out.statusNormalized =
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                Object.entries(value).map(([op, opValue]) => [op, mapFieldValue(model, "status", opValue)]),
              )
            : mapFieldValue(model, "status", value);
      }
      delete out.status;
      continue;
    }

    if (key === "executionState") {
      if (!Object.prototype.hasOwnProperty.call(out, "executionStateNormalized")) {
        out.executionStateNormalized =
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                Object.entries(value).map(([op, opValue]) => [op, mapFieldValue(model, "executionState", opValue)]),
              )
            : mapFieldValue(model, "executionState", value);
      }
      delete out.executionState;
      continue;
    }

    if (value && typeof value === "object") {
      out[key] = rewriteLegacyWhereToNormalized(model, value);
    }
  }
  return out;
}

function dualWriteNormalizedData(model, data) {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map((row) => dualWriteNormalizedData(model, row));

  const out = { ...data };

  if (model === "EditHistory") {
    if (Object.prototype.hasOwnProperty.call(out, "status")) {
      out.statusNormalized = normalizeEditHistoryStatus(out.status);
    }
    if (Object.prototype.hasOwnProperty.call(out, "executionState")) {
      out.executionStateNormalized = normalizeEditHistoryExecutionState(out.executionState);
    }
  } else if (model === "ExportJob") {
    if (Object.prototype.hasOwnProperty.call(out, "status")) {
      out.statusNormalized = normalizeExportJobStatus(out.status);
    }
    if (Object.prototype.hasOwnProperty.call(out, "executionState")) {
      out.executionStateNormalized = normalizeExportJobExecutionState(out.executionState);
    }
  } else if (model === "WebhookDelivery") {
    if (Object.prototype.hasOwnProperty.call(out, "status")) {
      out.statusNormalized = normalizeWebhookDeliveryStatus(out.status);
    }
  }

  return out;
}

prisma.$use(async (params, next) => {
  const model = params.model;
  if (!["EditHistory", "ExportJob", "WebhookDelivery"].includes(model || "")) {
    return next(params);
  }

  if (LEGACY_COMPAT.whereRewrite && params.args?.where) {
    params.args.where = rewriteLegacyWhereToNormalized(model, params.args.where);
  }

  if (params.args?.data) {
    params.args.data = dualWriteNormalizedData(model, params.args.data);
  }

  if (params.args?.create) {
    params.args.create = dualWriteNormalizedData(model, params.args.create);
  }

  if (params.args?.update) {
    params.args.update = dualWriteNormalizedData(model, params.args.update);
  }

  if (params.args?.createMany?.data) {
    params.args.createMany.data = dualWriteNormalizedData(model, params.args.createMany.data);
  }

  return next(params);
});

export default prisma;
