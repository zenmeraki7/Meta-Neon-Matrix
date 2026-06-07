import { TENANT_SCOPE_FIELDS_BY_MODEL } from "../config/tenantScopeGuard.js";

export const RETENTION_DAYS = Object.freeze({
  CHANGE_RECORD: 90,
  TARGET_SNAPSHOT_ITEM: 7,
  TARGET_SNAPSHOT: 7,
  SPREADSHEET_FILE: 30,
  EXPORT_HISTORY: 30,
  WEBHOOK_DELIVERY: 7,
  BULK_SUBMISSION: 30,
  FILTER_TRACK: 30,
  OPERATION_STAGE_PROGRESS: 30,
  MIRROR_ANOMALY: 30,
  OUTBOX_EVENT: 7,
  BILLING_EVENT: 365,
  ERROR_LOG: 30,
  DEAD_LETTER_JOB: 30,
  RECONCILE_SIGNAL_HOURS: 24,
  MIRROR_BATCH_GRACE: 7,
  EDIT_HISTORY: 365,
});

const policy = ({
  purpose,
  retention,
  trigger,
  dependencies,
}) => Object.freeze({ purpose, retention, trigger, dependencies });

const OPERATION_POLICY = policy({
  purpose: "Execute, recover, audit, or undo merchant operations.",
  retention: "Operation-specific; terminal detail is bounded by the nightly purge.",
  trigger: "Terminal state plus retention period, merchant erasure, or shop/redact.",
  dependencies: "Active operations, recovery, verification, and merchant history.",
});

const MIRROR_POLICY = policy({
  purpose: "Maintain the Shopify catalog mirror used by targeting and bulk editing.",
  retention: "Active and previous safe batch; retired batches receive a seven-day grace.",
  trigger: "Mirror batch retirement plus grace period, merchant erasure, or shop/redact.",
  dependencies: "Preview, targeting, reconciliation, and safe rollback verification.",
});

const ACCOUNT_POLICY = policy({
  purpose: "Operate the installed app and its merchant account.",
  retention: "While installed, subject to feature-specific retention.",
  trigger: "Merchant erasure or shop/redact.",
  dependencies: "Authentication, billing, installation, and app configuration.",
});

const DELIVERY_POLICY = policy({
  purpose: "Provide replay protection, queue recovery, and operational diagnostics.",
  retention: "Expires explicitly or after 7 to 30 days.",
  trigger: "Expiry or terminal state plus retention period.",
  dependencies: "Webhook deduplication, idempotency, and incident recovery.",
});

export const DATA_RETENTION_POLICY_BY_MODEL = Object.freeze({
  Product: MIRROR_POLICY,
  Variant: MIRROR_POLICY,
  Shop: ACCOUNT_POLICY,
  VariantMetafield: MIRROR_POLICY,
  DeadLetterChange: DELIVERY_POLICY,
  BulkEditSession: OPERATION_POLICY,
  BulkEditChange: OPERATION_POLICY,
  SyncCursor: MIRROR_POLICY,
  SpreadsheetFile: policy({
    purpose: "Store uploaded spreadsheet metadata and local/external file references.",
    retention: "Thirty days after storage creation unless merchant erasure occurs sooner.",
    trigger: "storageExpiresAt or merchant erasure; storage object must be deleted before row purge.",
    dependencies: "CSV import preview, import execution, and support diagnostics.",
  }),
  Store: ACCOUNT_POLICY,
  Subscription: ACCOUNT_POLICY,
  SyncHistory: MIRROR_POLICY,
  MirrorBatch: MIRROR_POLICY,
  EditHistory: policy({
    purpose: "Display merchant bulk-edit history and support rollback.",
    retention: "One year after completion.",
    trigger: "Merchant request, uninstall erasure, or one-year terminal retention.",
    dependencies: "Merchant history, rollback, and support diagnostics.",
  }),
  UndoOperation: OPERATION_POLICY,
  UndoOperationConflictChunk: OPERATION_POLICY,
  BulkEditRecoveryAudit: OPERATION_POLICY,
  EditHistoryIngestionCheckpoint: OPERATION_POLICY,
  RecurringEdit: OPERATION_POLICY,
  RecurringEditRun: OPERATION_POLICY,
  AutomaticProductRule: OPERATION_POLICY,
  AutomaticProductRuleRun: OPERATION_POLICY,
  TargetFreezeCommand: OPERATION_POLICY,
  OutboxEvent: policy({
    purpose: "Persist retryable side-effect events until they are dispatched.",
    retention: "Seven days after dispatch.",
    trigger: "DISPATCHED status plus purgeAfter, or merchant erasure.",
    dependencies: "Crash-safe event dispatch and target-freeze recovery.",
  }),
  AutomaticProductRuleProductState: OPERATION_POLICY,
  AutomaticRuleApplication: OPERATION_POLICY,
  ProductCodeSnippet: OPERATION_POLICY,
  Collection: MIRROR_POLICY,
  ExportHistory: policy({
    purpose: "Store export history and downloadable export file references.",
    retention: "Thirty days after storage creation unless merchant erasure occurs sooner.",
    trigger: "storageExpiresAt or merchant erasure; storage object must be deleted before row purge.",
    dependencies: "Merchant export downloads, scheduled export history, and support diagnostics.",
  }),
  ScheduledExport: OPERATION_POLICY,
  ScheduledExportRun: OPERATION_POLICY,
  ExportJob: OPERATION_POLICY,
  ChangeRecord: policy({
    purpose: "Record applied changes and provide the rollback path.",
    retention: "Ninety days after a terminal edit.",
    trigger: "Terminal edit plus 90 days, completed undo, or merchant erasure.",
    dependencies: "Undo, verification, and support diagnostics.",
  }),
  BulkSubmission: policy({
    purpose: "Recover and reconcile Shopify bulk mutation submissions.",
    retention: "Thirty days after processing.",
    trigger: "Processed plus 30 days or merchant erasure.",
    dependencies: "Crash recovery and result ingestion.",
  }),
  OperationStageProgress: policy({
    purpose: "Track operation stage progress, counters, and recovery diagnostics.",
    retention: "Thirty days after completion/update retention assignment.",
    trigger: "purgeAfter or merchant erasure.",
    dependencies: "Worker recovery, support diagnostics, and operation progress UI.",
  }),
  FilterTrack: policy({
    purpose: "Store saved filter and preview contracts for bulk-edit workflows.",
    retention: "Until expiresAt, or thirty days after creation when expiresAt is missing.",
    trigger: "expiresAt, null-expiry fallback age, or merchant erasure.",
    dependencies: "Preview contracts, saved filters, and replay diagnostics.",
  }),
  IdempotencyRecord: policy({
    purpose: "Prevent duplicate mutation and replay.",
    retention: "Until expiresAt.",
    trigger: "expiresAt or merchant erasure.",
    dependencies: "Request replay protection.",
  }),
  ReferralCode: ACCOUNT_POLICY,
  Location: MIRROR_POLICY,
  ProductMediaMirror: MIRROR_POLICY,
  InventoryItemMirror: MIRROR_POLICY,
  InventoryLevelMirror: MIRROR_POLICY,
  ErrorLog: policy({
    purpose: "Store tenant-scoped operational errors for diagnostics.",
    retention: "Thirty days.",
    trigger: "createdAt plus 30 days or merchant erasure.",
    dependencies: "Incident diagnosis and support.",
  }),
  TargetSnapshot: policy({
    purpose: "Freeze legacy ownerType/ownerId target sets used by targeting and reconciliation paths.",
    retention: "Until purgeAfter, normally seven days after creation.",
    trigger: "purgeAfter or merchant erasure.",
    dependencies: "Legacy targeting, reconciliation, automatic-rule, and import freeze flows.",
  }),
  TargetSnapshotSet: OPERATION_POLICY,
  TargetSnapshotItem: policy({
    purpose: "Freeze the exact preflight target set.",
    retention: "Seven days after terminal execution or snapshot expiry.",
    trigger: "Terminal operation plus seven days, snapshot expiry, or merchant erasure.",
    dependencies: "Execution determinism, verification, and rollback.",
  }),
  ProductCollection: MIRROR_POLICY,
  MetafieldMirror: MIRROR_POLICY,
  MirrorAnomaly: policy({
    purpose: "Record mirror drift, webhook, and reconciliation anomalies.",
    retention: "Thirty days after anomaly creation.",
    trigger: "purgeAfter or merchant erasure.",
    dependencies: "Mirror health investigation and repair.",
  }),
  ShopifySession: ACCOUNT_POLICY,
  MirrorReconcileSignal: policy({
    purpose: "Order and reconcile catalog webhook changes.",
    retention: "Twenty-four hours after terminal processing.",
    trigger: "Terminal processing plus 24 hours or merchant erasure.",
    dependencies: "Webhook ordering and mirror repair.",
  }),
  OperationFingerprint: DELIVERY_POLICY,
  BillingEvent: policy({
    purpose: "Record billing lifecycle events for audit and support.",
    retention: "One year after event creation.",
    trigger: "purgeAfter or merchant erasure.",
    dependencies: "Billing audit, merchant support, and dispute handling.",
  }),
  OperationLease: policy({
    purpose: "Coordinate concurrent tenant operations.",
    retention: "Until release or expiry.",
    trigger: "releasedAt, expiresAt, or merchant erasure.",
    dependencies: "Concurrency control and fencing.",
  }),
  OperationEnqueueIntent: DELIVERY_POLICY,
  DeadLetterJob: DELIVERY_POLICY,
  ProductTombstone: MIRROR_POLICY,
  WebhookDelivery: policy({
    purpose: "Deduplicate and audit mandatory Shopify webhooks.",
    retention: "Seven days.",
    trigger: "Seven days elapsed or merchant erasure.",
    dependencies: "Webhook replay protection.",
  }),
});

export const TENANT_MODELS_REQUIRING_DELETION = Object.freeze(
  [...Object.keys(TENANT_SCOPE_FIELDS_BY_MODEL), "DeadLetterJob"],
);

export function assertRetentionPolicyComplete() {
  const scoped = new Set(TENANT_MODELS_REQUIRING_DELETION);
  const declared = new Set(Object.keys(DATA_RETENTION_POLICY_BY_MODEL));
  const missing = [...scoped].filter((model) => !declared.has(model));
  const unknown = [...declared].filter((model) => !scoped.has(model));
  if (missing.length || unknown.length) {
    throw new Error(
      `RETENTION_POLICY_INCOMPLETE:missing=${missing.join(",")}:unknown=${unknown.join(",")}`,
    );
  }
  return true;
}

assertRetentionPolicyComplete();
