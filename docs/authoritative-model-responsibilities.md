# Architectural Guidelines & Data Model Invariants

This document outlines the core architectural principles governing data modeling, tenant isolation, index design, scheduler architecture, state machines, compare-and-swap protection, and mirror batch immutability in Meta-Neon-Matrix.

---

## 1. One Authoritative Model per Responsibility
Do not allow multiple tables to represent the same truth. Every domain concept has exactly one authoritative source:

- **Export history** → `ExportJob` only (`ExportHistory` projection retired).
- **Frozen targets** → `TargetSnapshotSet` + `TargetSnapshotItem`.
- **Tenant identity** → `Store.shopUrl` (`Store` is the single tenant root; legacy `shops`/`LegacyShop` retired).
- **Queue delivery** → `OperationEnqueueIntent`.
- **Domain events** → `OutboxEvent`.
- **Worker ownership** → `OperationLease`.
- **Idempotency** → `OperationFingerprint` or workflow-specific unique identities (`dispatchDedupeKey`, `ruleConfigHash`).

---

## 2. Shop-Scoped Keys Everywhere
Every merchant-owned row must include `shop` (or `shopDomain`/`shopUrl`).

Every lookup, relation, and uniqueness constraint must include `shop`:
- `@@unique([shop, executionIdentity])`
- `@@index([shop, status, updatedAt])`
- `@@unique([shop, snapshotSetId, targetKey])` (avoids weak globally-generated IDs alone).

Repository methods must never fetch merchant-owned records using `id` alone; query predicates must include `shop` (`where: { id, shop }`).

---

## 3. Composite Foreign Keys for Tenant Isolation
Child rows reference parent records using composite foreign keys containing both `shop` and `id`:
```prisma
editHistory EditHistory @relation(fields: [shop, editHistoryId], references: [shop, id])
```
This pattern prevents cross-tenant reference leakage. Applied across Edit histories, Export jobs, Recurring edits, Automatic rules, Snapshot sets, Queue commands, and Sync batches.

---

## 4. Index Actual Query Shapes, Not Every Field
Keep indexes only when they directly support active filters, sorting, joins, or cleanup flows.

A performant index matches query execution:
`WHERE columns` → `ORDER BY columns` → `stable tie-breaker`

Example:
```prisma
@@index([shop, mirrorBatchId, updatedAt, id])
```
Supports:
```sql
WHERE shop = ? AND mirror_batch_id = ? ORDER BY updated_at, id
```

---

## 5. Remove Indexes Duplicated by Constraints
Primary keys and unique constraints automatically build backing indexes.
Do not retain duplicate ordinary indexes (e.g. `@@unique([shop, id])` renders `@@index([shop, id])` redundant). Remove prefix duplicates to minimize write amplification and storage overhead.

---

## 6. Put Shop First Only for Tenant Queries
- **Tenant-Scoped Queries**: Lead with `shop` (e.g. `@@index([shop, status, createdAt])`).
- **Global Worker Claims**: Lead with `status` across all tenants (e.g. `@@index([status, availableAt, id])`).

`OperationEnqueueIntent` intentionally carries both tenant-scoped read indexes and global worker claim indexes for optimal access patterns.

---

## 7. Use Narrow Scheduler and Claim Tables
Avoid updating wide rule-definition rows during high-frequency worker claims.

`AutomaticProductRuleScheduleState` isolates execution claim metadata:
- `nextRunAt`, `claimedAt`, `claimOwner`, `fencingToken`, `disabledAt`

This design prevents lock contention, table bloat, and index churn on wide domain entity models.

---

## 8. Separate Immutable Commands from Mutable Execution State
Decouple immutable user requests from mutable execution lifecycles:
- `TargetFreezeCommand` *(immutable intent)* → `TargetSnapshotSet` *(frozen result)*
- `UndoCommand` *(immutable command)* → `UndoOperation` *(mutable execution)*
- Rule revision *(immutable definition snapshot)* → Rule run *(mutable lifecycle)*

Prevents retries or workers from mutating approved operation definitions.

---

## 9. Use Normalized Enums for Active Workflow State
Workflow logic must read and write normalized enums (e.g., `statusNormalized ExportJobStatus`) rather than unvalidated free-form strings.

Legacy string projections and boolean flags are retained strictly for backward compatibility and systematically deprecated as `deletedAt` and enum states become authoritative.

---

## 10. Keep Mirror Batches Immutable After Activation
Do not rewrite the active mirror batch in place during full synchronization.
Always build a new `MirrorBatch`, validate expected vs. actual counts, replay mutation journal entries, atomically switch `Store.currentProductMirrorBatchId`, mark the old batch retired, and clean it up asynchronously.

---

## 11. Database-Level State-Transition Protection (Compare-And-Swap)
Important state transitions use conditional SQL updates at the database level:
```sql
UPDATE ...
SET status = 'RUNNING'
WHERE id = ? AND shop = ? AND status = 'QUEUED';
```
Requires exactly 1 row affected. Used for approving previews, claiming commands, starting runs, cancelling work, activating batches, dispatching outbox rows, and reclaiming stale workers.

---

## 12. Enforce Snapshot Immutability
After a `TargetSnapshotSet` reaches a frozen state, target item definitions, `beforeValues`, `plannedMutation`, target hashes, and mirror batch identity are immutable. Only execution, verification, and undo state fields remain mutable during runtime execution.

---

## 13. Measure Before Removing Overlapping Indexes
Audit index utilization via `pg_stat_user_indexes` and `pg_stat_statements` before dropping questionable indexes to verify scan counts, write overhead, dead tuples, and query shapes.
