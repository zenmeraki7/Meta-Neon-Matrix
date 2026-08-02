# Model disposition evidence

This document records implementation state and deletion gates. A model marked
"retain" must not be removed merely because a replacement exists; every active
reader, writer, retry path, replay path, operational script, and deployed queue
must first be proven drained.

## Implemented authority changes

- `Product`, `Variant`, `Collection`, `InventoryItemMirror`,
  `InventoryLevelMirror`, and `MetafieldMirror` carry source timestamps/version,
  reconciliation state, and deletion/tombstone coverage. `ProductMediaMirror`
  and `ProductCollection` receive the same metadata in migration
  `20260801160000_model_disposition_hardening`.
- `MirrorBatch` activation is guarded by Store-row locking, mutation-version
  compare-and-set, a deferred semantic pointer trigger, and the partial unique
  index `MirrorBatch_one_active_per_shop_resource_uq`.
- `PreviewContract`, `TargetSnapshotSet`, and field-level
  `TargetSnapshotItem` provide the new preview/target authority schema and
  compare-and-set repository boundary. Historical preview strings are
  `LEGACY_UNTRUSTED` and non-executable. The manual preview controller still has
  a compatibility `FilterTrack` payload path; it must be dual-written and then
  switched to snapshot-item reads before `PreviewContract` is the sole runtime
  authority.
- `UndoOperation` can bind tenant-safely to `PreviewContract`; undo items and
  commands retain immutable hashes and per-field outcomes. The legacy undo
  worker remains active, so mandatory preview approval for every undo attempt is
  a deployment-path migration rather than a completed retirement.
- `OperationEnqueueIntent`, `OutboxEvent`, and `OperationLease` have independent
  claim identities, lease expiry, and monotonically increasing fencing tokens.
  Lease heartbeat, assertion, and release APIs accept the acquired fencing token
  and reject a mismatched stale token.
- `ChangeRecord` deduplicates by tenant, history, target, field, and attempt.
- Usage periods, reservations, and ledger entries are separate from billing
  audit (`BillingEvent`) and domain delivery (`OutboxEvent`).
- Recurring edits and scheduled exports use immutable definition revisions plus
  narrow scheduler-state claim rows, following
  `AutomaticProductRuleScheduleState`.
- `TerminalProjection` and `RunFinalizationIntent` are tenant-scoped. Rows whose
  merchant owner cannot be reconstructed are preserved in
  `UnresolvedTerminalOwnershipQuarantine`, not silently assigned to a shop.
- `Suggestion`, `AffiliateUser`, and `PlanEntitlement` remain global.

## Legacy metafield/session pipeline: not eligible for removal

Static runtime tracing still finds active dependencies:

- Queue processor: `Jobs/Workers/metafieldBulkWriteWorker.js`.
- Mutable ledger and raw SQL: `db/bulkEditChanges.js`,
  `db/bulkEditSessions.js`, and `db/variantMetafields.js`.
- Request flow: `controllers/sessionController.js`,
  `controllers/sessionWorkflowController.js`, and session use cases.
- Grid reads: product and variant grid repositories/services.
- Retry/dead-letter handling: `db/deadLetterChanges.js` and worker replay paths.

Therefore `VariantMetafield`, `BulkEditSession`, `BulkEditChange`, and
`DeadLetterChange` remain compatibility models. Removal requires all of:

1. Version-gate and drain the legacy queue, including delayed and active jobs.
2. Migrate grid reads and every raw-SQL caller to the normalized mirror models.
3. Reconcile session-ledger terminal outcomes into authoritative item records.
4. Replay or quarantine every dead letter and prove no retry code imports it.
5. Observe zero reads/writes for one full retention and retry window.
6. Remove code imports before dropping schema objects in a later deployment.

## OperationStageProgress: retain

The model has active writers in execute, result-ingest, verification, and undo
workflows. `operationStageProgressService.js` writes explicit named counters;
workers and recovery tests consume the stage projection. The old opaque counters
remain compatibility-only and are classified by
`LegacyOperationStageCounterClassification`.

Removal is allowed only after tracing dashboards, recovery jobs, worker imports,
tests, and operational scripts and proving that item-level status projections
replace every read. Until then, item rows remain authoritative and progress rows
remain rebuildable projections.

## FilterTrack split status

`FilterTrack` is retained as expiring filter/UI telemetry and temporary preview
compatibility storage. The target durable preview authority is `PreviewContract`;
durable request idempotency is `IdempotencyRecord`; durable billing work is now
the typed `SubscriptionCommand` model. The test/upgrade compatibility fallback
in `IdempotencyStoreService` still understands legacy `FilterTrack` rows.

The remaining split gate is to deploy the typed command path, dual-write manual
previews into immutable snapshot items, switch execution reads away from
`FilterTrack.value`, remove the idempotency fallback after the oldest supported
upgrade has passed, and observe no non-telemetry writes before dropping
durable-purpose fields from `FilterTrack`.
