# Request, query, polling, N+1, and worker reprocessing audit

Date: 2026-07-22

Scope: frontend request ownership, HTTP/GraphQL routes, controllers, services,
repositories, worker retry/recovery paths, and representative PostgreSQL plans.

## Executive result

| Area | Result |
| --- | --- |
| Duplicate frontend requests | Confirmed on cold Product and Dashboard loads |
| Browser GraphQL duplication | Not found; the frontend does not issue GraphQL requests |
| Shopify Admin GraphQL N+1 | No interactive read N+1 found; polling workers make bounded page/shop calls |
| Database N+1 | Confirmed in mirror mutation, catalog polling, product deletion, and mirror apply paths |
| Polling | Mostly bounded by visibility and terminal status; overlapping sync APIs remain separate sources of truth |
| Worker reprocessing | Confirmed stuck `DISPATCHING` gap in OperationEnqueueIntent; outbox and result-ingest paths are protected |
| Live SQL plans | Not captured: no `DATABASE_URL`, `.env`, or generated Prisma client is available in this workspace |

## Confirmed findings

### P1: Product bootstrap races three child queries

`Products.jsx` starts `bootstrap-products` during the same render that invokes
`useFilterRegistry`, `useSyncStatusHelpers`, and `useProducts`. On the first
render, all `initialData` values are undefined because the bootstrap response has
not arrived. React Query therefore starts all four requests:

1. `GET /api/bootstrap/products?limit=50`
2. `GET /api/products/filter-registry`
3. `GET /api/sync/sync-status/summary`
4. `POST /api/products/get-all?limit=50`

The bootstrap endpoint already computes the filter registry, sync summary, and
first product page. Query keys do not deduplicate these calls because each uses a
different key and URL. Evidence:

- `web/frontend/Domain/products/list/pages/Products.jsx:63-152`
- `web/frontend/Domain/products/list/hooks/useProducts.js:184-217`
- `web/frontend/Domain/products/list/hooks/useFilterRegistry.js:50-68`
- `web/frontend/hooks/useSyncStatusQuery.js:97-118`
- `web/controllers/bootstrapController.js:77-99`

This duplicates the expensive product query and its count on every uncached cold
load. It can also repeat Store and SyncHistory reads.

Required correction: gate the three child queries on bootstrap completion, then
seed their exact React Query keys with `queryClient.setQueryData`. Alternatively,
remove those resources from the bootstrap endpoint and let the individual query
keys own them. Do not retain both ownership models.

### P1: Dashboard bootstrap races Store details

`DashboardPage` starts `bootstrap-dashboard` and immediately calls
`useStoreAccess`. Its `initialData` is undefined on the first render, so
`GET /api/store/details` runs concurrently with `GET /api/bootstrap/dashboard`.
The bootstrap endpoint already calls `getStoreAccessDto`.

Evidence:

- `web/frontend/Domain/dashboard/pages/DashboardPage.jsx:137-149`
- `web/frontend/hooks/useStoreDetailsQuery.js:4-13`
- `web/controllers/bootstrapController.js:124-143`

Required correction: make bootstrap the sole cold-load owner and enable the
child store-details query only after bootstrap has settled, or eliminate Store
details from bootstrap.

### P2: Product rows trigger an unconditional variants request

After the product page resolves, it always posts all visible product IDs to
`/api/variants/query`, up to 500 rows. The repository is batched—not N+1—but the
request occurs even when no variant detail is expanded. This is avoidable
overfetch and adds a Store lookup plus Variant query to every page/prefetch.

Evidence:

- `web/frontend/Domain/products/list/pages/Products.jsx:175-213`
- `web/repositories/variantGridRepository.js:16-63`

Required correction: fetch variants on expansion, or include the exact compact
variant projection in the owning product response when it is always rendered.

### P1: Catalog missed-update polling performs approximately 3N writes

For every metafield returned, the worker performs a MetafieldMirror upsert, a
MirrorMutationJournal insert, and a MirrorReconcileSignal update. These are
serial awaits inside product/variant/metafield loops and one long transaction.

Evidence: `web/Jobs/Workers/catalogMissedUpdatesPollingWorker.js:59-119`.

The cursor deliberately subtracts one second, so repeated source records are
expected. The mirror upsert is idempotent, but the journal insert is not; overlap
can create new journal rows and reconciliation work for unchanged metafields.

Required correction: flatten the page, bulk-stage it, execute one set-based
upsert, insert journals only for rows whose typed value changed, and update one
reconcile signal per product using the maximum resulting sequence.

### P1: Product webhook variant persistence is row-by-row

`applyProductUpsertMutation` performs one Variant upsert per incoming variant
inside a serializable transaction.

Evidence: `web/repositories/mirrorMutationRepository.js:42-87`.

Required correction: use a staging CTE or bulk `INSERT ... ON CONFLICT DO UPDATE`
for the full variant set, then delete missing variants once.

### P1: Bulk-edit mirror application is row-by-row

Each ChangeRecord can produce a Product update, multiple Variant updates, and a
ChangeRecord update. Verified Shopify reconciliation additionally opens one
transaction per product and upserts every variant serially.

Evidence:

- `web/services/bulkEdit/BulkEditMirrorApplyService.js:248-301`
- `web/services/bulkEdit/BulkEditMirrorApplyService.js:388-447`

Required correction: group identical patch shapes, update IDs in batches, and
write ChangeRecord outcomes using set-based SQL or bounded bulk statements.

### P2: Product deletion performs one inventory-level delete per item

The worker loads InventoryItemMirror rows and issues a separate
InventoryLevelMirror delete for each item.

Evidence: `web/Jobs/Workers/productDeleteWorker.js:92-106`.

Required correction: collect `(inventoryItemId, mirrorBatchId)` tuples and
delete using a tuple `IN`, join, or `USING` clause.

### P1: OperationEnqueueIntent can remain DISPATCHING forever

The dispatcher first reads PENDING rows and then CAS-updates each row to
DISPATCHING. If the process crashes after the queue publish or before the final
status update, the recovery worker only scans PENDING rows. There is no
`lockedAt`, owner token, stale-claim reset, retry schedule, or dead-letter limit.

Evidence:

- `web/services/operationEnqueueIntentService.js:72-132`
- `web/Jobs/Workers/operationEnqueueIntentRecoveryWorker.js:22-43`

The deterministic BullMQ `jobId` prevents most duplicate queue jobs, but it does
not recover the database intent row.

Required correction: use the same lease-based `FOR UPDATE SKIP LOCKED` pattern
as OutboxEvent, including `nextAttemptAt`, `lockedAt`, `lockedBy`, maximum
attempts, and dead-letter state.

## Paths that are already protected

- OutboxEvent claims are atomic with `FOR UPDATE SKIP LOCKED`, lease ownership,
  retry scheduling, and dead-lettering (`web/workers/outboxDispatcherWorker.js`).
- Missed bulk-operation polling uses a Redis NX cooldown and deterministic
  result-ingest job IDs. Duplicate polling can occur, but duplicate downstream
  queue insertion is bounded.
- Recurring-edit and scheduled-export scheduler reservations use advisory locks
  and tenant-scoped execution keys.
- Product variant-grid loading is one batched query, not one query per product.
- Product and history cursor pagination use stable tie breakers.
- Export detail/list polling stops on terminal status and is disabled in hidden
  tabs. Sync summary polling is also visibility-aware.
- The old Redux `useExportHistoryList` hook appears unused by the active History
  page; active export history uses React Query.

## GraphQL assessment

The browser does not use Apollo operations despite `@apollo/client` being a root
dependency. Interactive GraphQL usage is server-side and limited primarily to
Shopify billing/timezone operations. Catalog recovery workers use one Shopify
Admin GraphQL request per page or per stale bulk operation, not one request per
rendered product.

One separate correctness risk exists in catalog polling: `variants(first: 250)`
and `metafields(first: 100)` do not paginate their nested connections. Products
above those limits are partially mirrored.

## Representative PostgreSQL EXPLAIN probes

No live plan can be truthfully reported from this checkout because there is no
database connection configuration. Run these on a representative Neon branch
after deploying migrations, substituting real tenant/batch values. Use
`EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT TEXT)` for read-only SELECTs.
Use plain `EXPLAIN` rather than `ANALYZE` for mutating statements unless wrapped
in a transaction that is explicitly rolled back.

```sql
-- Product first page; should use Product_shop_mirrorBatchId_createdAt_id_idx.
EXPLAIN (ANALYZE, BUFFERS, SETTINGS)
SELECT "id", "title", "createdAt"
FROM "Product"
WHERE "shop" = $1 AND "mirrorBatchId" = $2
ORDER BY "createdAt" DESC, "id" DESC
LIMIT 51;

-- Product cursor page; should remain an index range scan.
EXPLAIN (ANALYZE, BUFFERS, SETTINGS)
SELECT "id", "title", "createdAt"
FROM "Product"
WHERE "shop" = $1 AND "mirrorBatchId" = $2
  AND ("createdAt", "id") < ($3, $4)
ORDER BY "createdAt" DESC, "id" DESC
LIMIT 51;

-- Variant grid batch; inspect whether the productId/position index is chosen.
EXPLAIN (ANALYZE, BUFFERS, SETTINGS)
SELECT "id", "productId", "position", "sku", "price"
FROM "Variant"
WHERE "shop" = $1 AND "mirrorBatchId" = $2
  AND "productId" = ANY($3::text[])
ORDER BY "productId", "position", "id"
LIMIT 500;

-- Edit history keyset page.
EXPLAIN (ANALYZE, BUFFERS, SETTINGS)
SELECT "id", "statusNormalized", "createdAt"
FROM "EditHistory"
WHERE "shop" = $1 AND ("createdAt", "id") < ($2, $3)
ORDER BY "createdAt" DESC, "id" DESC
LIMIT 21;

-- Due outbox claim; run plain EXPLAIN because this mutates rows.
EXPLAIN
WITH candidates AS (
  SELECT "id" FROM "OutboxEvent"
  WHERE "statusNormalized" = 'PENDING'
    AND "nextAttemptAt" <= now()
  ORDER BY "nextAttemptAt", "createdAt"
  FOR UPDATE SKIP LOCKED
  LIMIT 50
)
UPDATE "OutboxEvent" o
SET "lockedAt" = now()
FROM candidates c
WHERE o."id" = c."id";
```

For each plan, reject unexpected sequential scans on a large tenant/batch,
external sorts, high `Rows Removed by Filter`, heap reads greatly exceeding rows
returned, or nested loops whose inner scan executes once per returned parent.

## Recommended order

1. Remove Product and Dashboard bootstrap ownership races.
2. Add lease/retry recovery to OperationEnqueueIntent.
3. Batch catalog missed-update writes and suppress unchanged journal entries.
4. Batch bulk-edit mirror reconciliation and webhook variant upserts.
5. Make variants lazy or fold their compact projection into the product owner.
6. Capture the supplied plans on a production-sized Neon branch and compare
   `pg_stat_statements` calls/mean time before and after.
