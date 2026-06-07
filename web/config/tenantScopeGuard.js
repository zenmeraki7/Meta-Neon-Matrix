export const TENANT_SCOPE_FIELDS_BY_MODEL = Object.freeze({
  Product: ["shop"],
  Variant: ["shop"],
  VariantMetafield: ["shopId"],
  DeadLetterChange: ["shopId"],
  BulkEditSession: ["shopId"],
  BulkEditChange: ["shopId"],
  SyncCursor: ["shopId"],
  SpreadsheetFile: ["shop"],
  Store: ["shopUrl"],
  Subscription: ["shop"],
  SyncHistory: ["shop"],
  MirrorBatch: ["shop"],
  EditHistory: ["shop"],
  UndoOperation: ["shop"],
  UndoOperationConflictChunk: ["shop"],
  BulkEditRecoveryAudit: ["shop"],
  EditHistoryIngestionCheckpoint: ["shop"],
  RecurringEdit: ["shop"],
  RecurringEditRun: ["shop"],
  AutomaticProductRule: ["shop"],
  AutomaticProductRuleRun: ["shop"],
  TargetFreezeCommand: ["shop"],
  OutboxEvent: ["shop"],
  AutomaticProductRuleProductState: ["shop"],
  AutomaticRuleApplication: ["shop"],
  ProductCodeSnippet: ["shop"],
  Collection: ["shop"],
  ExportHistory: ["shop"],
  ScheduledExport: ["shop"],
  ScheduledExportRun: ["shop"],
  ExportJob: ["shop"],
  ChangeRecord: ["shop"],
  BulkSubmission: ["shop"],
  OperationStageProgress: ["shop"],
  FilterTrack: ["shop"],
  ReferralCode: ["shop"],
  Location: ["shop"],
  ProductMediaMirror: ["shop"],
  InventoryItemMirror: ["shop"],
  InventoryLevelMirror: ["shop"],
  ErrorLog: ["shop"],
  TargetSnapshot: ["shop"],
  TargetSnapshotSet: ["shop"],
  TargetSnapshotItem: ["shop"],
  ProductCollection: ["shop"],
  MetafieldMirror: ["shop"],
  MirrorAnomaly: ["shop"],
  ShopifySession: ["shop"],
  MirrorReconcileSignal: ["shop"],
  OperationFingerprint: ["shop"],
  BillingEvent: ["shop"],
  OperationLease: ["shop"],
  OperationEnqueueIntent: ["shop"],
  IdempotencyRecord: ["shop"],
  ProductTombstone: ["shop"],
  WebhookDelivery: ["shop"],
});

const TENANT_SCOPED_SQL_TABLES = new Set(
  Object.keys(TENANT_SCOPE_FIELDS_BY_MODEL).flatMap((model) => {
    const snake = model.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    return [model.toLowerCase(), snake, `${snake}s`];
  }),
);

const TENANT_SCOPED_WHERE_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert",
]);

const TENANT_SCOPED_DATA_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "upsert",
]);

function isTenantScopeValue(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "bigint") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, "equals")) return false;
  return isTenantScopeValue(value.equals);
}

function isCompoundTenantSelectorKey(key, tenantField) {
  return (
    key === tenantField ||
    key.startsWith(`${tenantField}_`) ||
    key.endsWith(`_${tenantField}`) ||
    key.includes(`_${tenantField}_`)
  );
}

function whereHasTenantScope(where, tenantFields) {
  if (!where || typeof where !== "object" || Array.isArray(where)) return false;

  for (const field of tenantFields) {
    if (
      Object.prototype.hasOwnProperty.call(where, field) &&
      isTenantScopeValue(where[field])
    ) {
      return true;
    }
  }

  for (const [key, value] of Object.entries(where)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const field of tenantFields) {
      if (
        isCompoundTenantSelectorKey(key, field) &&
        Object.prototype.hasOwnProperty.call(value, field) &&
        isTenantScopeValue(value[field])
      ) {
        return true;
      }
    }
  }

  return false;
}

function dataHasTenantScope(data, tenantFields) {
  if (!data || typeof data !== "object") return false;
  const rows = Array.isArray(data) ? data : [data];
  if (!rows.length) return false;
  return rows.every((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    return tenantFields.some(
      (field) =>
        Object.prototype.hasOwnProperty.call(row, field) &&
        isTenantScopeValue(row[field]),
    );
  });
}

export function assertTenantScopedPrismaArgs(model, operation, args = {}) {
  const tenantFields = TENANT_SCOPE_FIELDS_BY_MODEL[model];
  if (!tenantFields) return;

  if (
    TENANT_SCOPED_WHERE_OPERATIONS.has(operation) &&
    !whereHasTenantScope(args?.where, tenantFields)
  ) {
    throw new Error(
      `TENANT_SCOPE_REQUIRED:${model}.${operation}:where:${tenantFields.join("|")}`,
    );
  }

  if (TENANT_SCOPED_DATA_OPERATIONS.has(operation)) {
    if (operation === "upsert") {
      if (!dataHasTenantScope(args?.create, tenantFields)) {
        throw new Error(
          `TENANT_SCOPE_REQUIRED:${model}.${operation}:create:${tenantFields.join("|")}`,
        );
      }
      return;
    }

    if (!dataHasTenantScope(args?.data, tenantFields)) {
      throw new Error(
        `TENANT_SCOPE_REQUIRED:${model}.${operation}:data:${tenantFields.join("|")}`,
      );
    }
  }
}

function rawSqlText(args) {
  const first = Array.isArray(args) ? args[0] : args;
  if (typeof first === "string") return first;
  if (Array.isArray(first?.strings)) return first.strings.join("?");
  if (Array.isArray(first?.sql)) return first.sql.join("?");
  if (typeof first?.sql === "string") return first.sql;
  return "";
}

export function assertTenantScopedRawPrismaArgs(operation, args = {}) {
  if (!["$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"].includes(operation)) {
    return;
  }
  const sql = rawSqlText(args);
  const normalized = sql.toLowerCase();
  const touchesTenantTable = [...TENANT_SCOPED_SQL_TABLES].some((table) =>
    new RegExp(`(?:^|[^a-z0-9_])["']?${table}["']?(?:[^a-z0-9_]|$)`, "i").test(normalized));
  if (!touchesTenantTable) return;

  const hasTenantPredicate =
    /["']?(shop|shop_id|shopid|shop_url|shopurl)["']?\s*(=|in\s*\(|is\s+not\s+distinct\s+from)/i.test(sql);
  const isScopedInsert =
    /^\s*(with\b[\s\S]*?\b)?insert\s+into\b/i.test(sql)
    && /["']?(shop|shop_id|shopid|shop_url|shopurl)["']?/i.test(sql);

  if (!hasTenantPredicate && !isScopedInsert) {
    throw new Error(`TENANT_SCOPE_REQUIRED:RAW.${operation}:shop_predicate`);
  }
}

export function getTenantScopeFields(model) {
  return TENANT_SCOPE_FIELDS_BY_MODEL[model] || null;
}
