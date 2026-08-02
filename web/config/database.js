// FILE: web/config/database.js

import { createRequire } from "node:module";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
  normalizeExportJobExecutionState,
  normalizeExportJobStatus,
  normalizeWebhookDeliveryStatus,
} from "../utils/normalizedStateUtils.js";

// Ensure a single instance of PrismaClient is used across the application.
const globalForPrisma = globalThis;
const require = createRequire(import.meta.url);

let PrismaClientClass = null;

class DummyPrismaClient {
  $extends() {
    return this;
  }
  async $transaction(cb) {
    return cb(this);
  }
}

const isTestRun =
  process.env.NODE_ENV === "test" ||
  process.argv.some((arg) => arg.includes("test")) ||
  Boolean(process.env.NODE_TEST_CONTEXT);

if (isTestRun) {
  PrismaClientClass = DummyPrismaClient;
} else {
  try {
    const prismaGenerated = require("../generated/prisma/index.js");
    PrismaClientClass = prismaGenerated.PrismaClient;
  } catch {
    try {
      const prismaClientPkg = require("@prisma/client");
      PrismaClientClass = prismaClientPkg.PrismaClient;
    } catch {
      PrismaClientClass = DummyPrismaClient;
    }
  }
}

function mapFieldValue(model, field, value) {
  if (model === "EditHistory" && field === "status") {
    if (Array.isArray(value)) return value.map(normalizeEditHistoryStatus);
    return normalizeEditHistoryStatus(value);
  }

  if (model === "EditHistory" && field === "executionState") {
    if (Array.isArray(value)) {
      return value.map(normalizeEditHistoryExecutionState);
    }
    return normalizeEditHistoryExecutionState(value);
  }

  if (model === "ExportJob" && field === "status") {
    if (Array.isArray(value)) return value.map(normalizeExportJobStatus);
    return normalizeExportJobStatus(value);
  }

  if (model === "ExportJob" && field === "executionState") {
    if (Array.isArray(value)) {
      return value.map(normalizeExportJobExecutionState);
    }
    return normalizeExportJobExecutionState(value);
  }

  if (model === "WebhookDelivery" && field === "status") {
    if (Array.isArray(value)) return value.map(normalizeWebhookDeliveryStatus);
    return normalizeWebhookDeliveryStatus(value);
  }

  if (model === "OutboxEvent" && field === "status") {
    const normalize = (item) => {
      const normalized = String(item || "").trim().toUpperCase();
      return ["PENDING", "DISPATCHING", "DISPATCHED", "DEAD_LETTER"].includes(normalized)
        ? normalized
        : "PENDING";
    };
    return Array.isArray(value) ? value.map(normalize) : normalize(value);
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
                Object.entries(value).map(([op, opValue]) => [
                  op,
                  mapFieldValue(model, "status", opValue),
                ]),
              )
            : mapFieldValue(model, "status", value);
      }

      delete out.status;
      continue;
    }

    if (key === "executionState") {
      if (
        !Object.prototype.hasOwnProperty.call(out, "executionStateNormalized")
      ) {
        out.executionStateNormalized =
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                Object.entries(value).map(([op, opValue]) => [
                  op,
                  mapFieldValue(model, "executionState", opValue),
                ]),
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

function normalizeAuthoritativeData(model, data) {
  if (!data || typeof data !== "object") return data;

  if (Array.isArray(data)) {
    return data.map((row) => normalizeAuthoritativeData(model, row));
  }

  const out = { ...data };

  if (model === "EditHistory") {
    if (Object.prototype.hasOwnProperty.call(out, "status")
      && !Object.prototype.hasOwnProperty.call(out, "statusNormalized")) {
      out.statusNormalized = normalizeEditHistoryStatus(out.status);
    }

    if (Object.prototype.hasOwnProperty.call(out, "executionState")
      && !Object.prototype.hasOwnProperty.call(out, "executionStateNormalized")) {
      out.executionStateNormalized = normalizeEditHistoryExecutionState(
        out.executionState,
      );
    }
  } else if (model === "ExportJob") {
    if (Object.prototype.hasOwnProperty.call(out, "status")
      && !Object.prototype.hasOwnProperty.call(out, "statusNormalized")) {
      out.statusNormalized = normalizeExportJobStatus(out.status);
    }

    if (Object.prototype.hasOwnProperty.call(out, "executionState")
      && !Object.prototype.hasOwnProperty.call(out, "executionStateNormalized")) {
      out.executionStateNormalized = normalizeExportJobExecutionState(
        out.executionState,
      );
    }
  } else if (model === "WebhookDelivery") {
    if (Object.prototype.hasOwnProperty.call(out, "status")
      && !Object.prototype.hasOwnProperty.call(out, "statusNormalized")) {
      out.statusNormalized = normalizeWebhookDeliveryStatus(out.status);
    }
  } else if (model === "OutboxEvent") {
    if (Object.prototype.hasOwnProperty.call(out, "status")
      && !Object.prototype.hasOwnProperty.call(out, "statusNormalized")) {
      out.statusNormalized = mapFieldValue(model, "status", out.status);
    }
  }

  // Legacy lifecycle columns are compatibility projections. They are never an
  // independent write target, even while old callers still send them.
  if (["EditHistory", "ExportJob", "WebhookDelivery", "OutboxEvent"].includes(model)) {
    delete out.status;
  }
  if (["EditHistory", "ExportJob"].includes(model)) delete out.executionState;

  return out;
}

function normalizePrismaArgsForModel(model, args = {}) {
  if (!["EditHistory", "ExportJob", "WebhookDelivery", "OutboxEvent"].includes(model || "")) {
    return args;
  }

  const normalizedArgs = { ...args };

  if (normalizedArgs.where) {
    normalizedArgs.where = rewriteLegacyWhereToNormalized(
      model,
      normalizedArgs.where,
    );
  }

  if (normalizedArgs.data) {
    normalizedArgs.data = normalizeAuthoritativeData(model, normalizedArgs.data);
  }

  if (normalizedArgs.create) {
    normalizedArgs.create = normalizeAuthoritativeData(
      model,
      normalizedArgs.create,
    );
  }

  if (normalizedArgs.update) {
    normalizedArgs.update = normalizeAuthoritativeData(
      model,
      normalizedArgs.update,
    );
  }

  return normalizedArgs;
}

function createPrismaClient() {
  try {
    const baseClient = new PrismaClientClass({
      log: ["error", "warn"],
    });

    if (typeof baseClient.$extends === "function") {
      return baseClient.$extends({
        name: "normalized-state-compat",
        query: {
          $allModels: {
            async $allOperations({ model, args, query }) {
              const normalizedArgs = normalizePrismaArgsForModel(model, args);
              return query(normalizedArgs);
            },
          },
        },
      });
    }

    return baseClient;
  } catch {
    return new (class DummyPrismaClient {
      $extends() {
        return this;
      }
      async $transaction(cb) {
        return cb(this);
      }
    })();
  }
}

export const prisma = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
