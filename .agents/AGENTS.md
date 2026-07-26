# Project Guidelines & Architectural Rules

## 1. One Authoritative Model per Responsibility

Do not allow multiple tables to represent the same truth.

### Key Responsibilities & Authoritative Sources:
- **Export history** → `ExportJob` only (`ExportHistory` projection retired).
- **Frozen targets** → `TargetSnapshotSet` + `TargetSnapshotItem`.
- **Tenant identity** → `Store.shopUrl` (`Store` is the single tenant root; legacy `shops`/`LegacyShop` retired).
- **Queue delivery** → `OperationEnqueueIntent`.
- **Domain events** → `OutboxEvent`.
- **Worker ownership** → `OperationLease`.
- **Idempotency** → `OperationFingerprint` or workflow-specific unique identities (e.g. `dispatchDedupeKey`, `ruleConfigHash`).

Compatibility fields may temporarily remain for legacy API contracts, but every duplicated concept must have one documented authoritative source.

## 2. Shop-Scoped Keys Everywhere

Every merchant-owned row must include `shop` (or `shopDomain` / `shopUrl` for the tenant root).

Every lookup, relation, and uniqueness rule should normally include it:
- `@@unique([shop, executionIdentity])`
- `@@index([shop, status, updatedAt])`

Avoid relying on globally generated IDs alone:
- **Weak tenant contract**: `@@unique([snapshotSetId, targetKey])`
- **Strong tenant contract**: `@@unique([shop, snapshotSetId, targetKey])`

Repository methods should never fetch merchant-owned records using only `id`. Always include `shop` in query predicates (e.g. `where: { id, shop }`).

## 3. Composite Foreign Keys for Tenant Isolation

Child rows must reference parent models using both tenant (`shop`) and identity (`id`):
```prisma
editHistory EditHistory @relation(fields: [shop, editHistoryId], references: [shop, id])
```
This prevents a row belonging to one shop from referencing a record owned by another shop.

Use this composite relation pattern for:
- Edit histories
- Export jobs
- Recurring edits
- Automatic rules
- Snapshot sets
- Queue commands
- Sync batches

## 4. Index Actual Query Shapes, Not Every Field

Keep indexes only when they support real filters, sorting, joins, or cleanup flows.

A useful index should generally match:
`WHERE columns` → `ORDER BY columns` → `stable tie-breaker`

Example:
```prisma
@@index([shop, mirrorBatchId, updatedAt, id])
```
Supports:
```sql
WHERE shop = ? AND mirror_batch_id = ? ORDER BY updated_at, id
```
Do not create separate indexes merely because a field exists.

## 5. Remove Indexes Duplicated by Constraints

Primary keys and unique constraints automatically create underlying indexes.

- Do not maintain an identical ordinary index alongside a unique constraint:
  - `@@unique([shop, id])`
  - `@@index([shop, id])` ❌ *(redundant)*
- Audit indexes that duplicate composite primary-key or unique constraint prefixes. Remove redundant indexes to save write and storage overhead.

## 6. Put Shop First Only for Tenant Queries

For application tenant queries, leading with `shop` is standard:
```prisma
@@index([shop, status, createdAt])
```

For global background workers claiming work across all shops, global status-first indexes are required:
```prisma
@@index([status, availableAt, id])
```
*`OperationEnqueueIntent` maintains both tenant-scoped and global dispatcher indexes because application reads and global worker claims have distinct access patterns.*

## 7. Use Narrow Scheduler and Claim Tables

Do not repeatedly update large rule-definition rows just to claim scheduled work.

`AutomaticProductRuleScheduleState` is the standard narrow claim table pattern:
- `nextRunAt`
- `claimedAt`
- `claimOwner`
- `fencingToken`
- `disabledAt`

This eliminates row bloat, lock contention, and unnecessary index updates on wide rule definition tables. Apply this pattern to high-frequency worker scheduling and claim state.

## 8. Separate Immutable Commands from Mutable Execution State

Keep immutable request data separate from mutable runtime status:
- `TargetFreezeCommand` *(immutable freeze intent)* → `TargetSnapshotSet` *(frozen result)*
- `UndoCommand` *(immutable undo command)* → `UndoOperation` *(mutable runtime state)*
- Rule revision *(immutable command snapshot)* → Rule run *(mutable execution)*

This prevents retries, background workers, or controllers from mutating the semantic definition of an approved operation.

## 9. Use Normalized Enums for Active Workflow State

Avoid free-form strings for actively queried lifecycle state.

Prefer:
```prisma
statusNormalized ExportJobStatus
```
over:
```prisma
status String
```

Legacy string projections may remain temporarily during transitions, but all active workflow logic must read and write normalized enums only.

Proactively deprecate and remove:
- Legacy status and lifecycle strings
- Boolean projections of enum state
- Old soft-delete flags where `deletedAt` is authoritative

## 10. Keep Mirror Batches Immutable After Activation

Do not rewrite the active mirror batch in place during full synchronization.

Always follow the atomic switch flow:
1. Build a new `MirrorBatch`.
2. Validate expected versus actual counts.
3. Replay mutation journal entries.
4. Atomically switch `Store.currentProductMirrorBatchId`.
5. Mark the old batch retired and clean it asynchronously.

## 11. Database-Level State-Transition Protection (Compare-And-Swap)

Important state transitions must execute conditional updates at the database level:
```sql
UPDATE ...
SET status = 'RUNNING'
WHERE id = ? AND shop = ? AND status = 'QUEUED';
```
Require exactly one row affected before proceeding. Do not perform `findFirst`, validate in JavaScript, and update separately.

Use CAS for:
- Approving previews
- Claiming commands
- Starting runs
- Cancelling work
- Activating batches
- Dispatching outbox rows
- Reclaiming stale workers

## 12. Enforce Snapshot Immutability

After a `TargetSnapshotSet` reaches a frozen/approved state:
- No new items
- No deleted items
- No changes to `beforeValues`
- No changes to `plannedMutation`
- No changes to target hashes
- No changes to mirror batch identity

Only execution, verification, and undo status fields remain mutable during execution.

## 13. Measure Before Removing Overlapping Indexes

Before dropping questionable indexes, collect statistics via:
- `pg_stat_user_indexes`
- `pg_stat_statements`

Inspect index scans, sequential scans, write-heavy unused indexes, slow query shapes, duplicate indexes, dead tuples, and queries sorting after filtering. Zero-scan indexes require audit before removal to ensure write and storage efficiency.

