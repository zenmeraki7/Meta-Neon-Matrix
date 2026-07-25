# Performance, request, query, and worker verification

## Verification environment

The code-level verification was performed on 2026-07-22. Live measurements are
currently blocked because no local web server is listening, dependencies and the
generated Prisma client are absent, and no Neon `DATABASE_URL` or `DIRECT_URL` is
configured. Results below distinguish verified invariants from measurements that
must be collected on a migrated Neon branch.

## Cold navigation requests

Code verified:

- Products cold navigation starts with `GET /api/bootstrap/products?limit=50`.
- Filter-registry and sync-status queries remain disabled until bootstrap succeeds
  or fails. Successful bootstrap data is installed as fresh query data.
- Product navigation no longer issues an eager `/api/variants/query` request.
- Dashboard Store lookup remains disabled while `/api/bootstrap/dashboard` is in
  flight. Bootstrap Store data hydrates the shared `store-details` query.
- The unused independent dashboard Store loader was removed.

Expected cold request count after authentication infrastructure: one products
bootstrap request or one dashboard bootstrap request. A real browser trace is
still required to count App Bridge/session requests and confirm no component
outside these trees starts another request.

## Write and transaction counts

Structural counts for a batch with `P` products, `V` variants, `C` change records,
and `M` metafields:

| Path | Previous writes/transactions | Current writes/transactions |
| --- | --- | --- |
| Bulk mirror apply | up to `P + V + C` update statements | at most 3 set-based update statements in 1 transaction |
| Verified reconciliation | `P` transactions plus product/variant writes | at most 3 set-based statements in 1 transaction |
| Metafield polling | approximately `3M` writes in 1 transaction | 2 set-based statements in 1 transaction |
| Product inventory deletion | one delete per inventory item | 1 tenant/batch-scoped delete statement |
| Webhook variants | `V` upserts | 1 set-based upsert |

Runtime `pg_stat_statements`, WAL, and transaction counts remain to be measured on
a representative Neon branch.

## Enqueue crash recovery and retry safety

Verified in code/contracts:

- Claim uses `FOR UPDATE SKIP LOCKED` and `UPDATE ... RETURNING`.
- A claim records owner, start time, heartbeat time, and increments attempts.
- A `DISPATCHING` row older than five minutes is eligible for reclamation.
- Completion/failure transitions require matching shop, status, and dispatch owner.
- Redis failures return the intent to `PENDING` and clear claim state.
- Every dispatch requires deterministic `options.jobId`; a crash after Redis accepts
  the job but before PostgreSQL marks `DISPATCHED` therefore retries the same BullMQ
  identity rather than creating a second logical job.

An actual process-kill test remains required against Redis and Neon to verify the
configured BullMQ retention policy preserves that identity for the complete stale
claim window.

## Tenant scoping and batch bounds

Verified:

- Product, Variant, ChangeRecord, inventory deletion, metafield merge, journal,
  and reconciliation-signal bulk SQL all constrain `shop`.
- Mirror-owned writes additionally constrain `mirrorBatchId` where applicable.
- Enqueue completion/failure transitions constrain shop and claim owner. Its claim
  query is intentionally global because it is a system dispatcher.
- Enqueue claims are capped at 500 rows.
- Bulk mirror/reconciliation and webhook variant batches are capped at 500 rows.
- Polling is capped at 1,000 metafields and 250 products per transaction.

## Neon query-plan runbook

After applying migrations to a representative branch, capture plans with production-
like row counts for each set-based statement:

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, VERBOSE)
SELECT "id"
FROM "OperationEnqueueIntent"
WHERE "status" = 'PENDING' AND "runAt" <= now()
ORDER BY "runAt", "createdAt", "id"
FOR UPDATE SKIP LOCKED
LIMIT 100;
ROLLBACK;
```

Also run the exact parameterized Product, Variant, ChangeRecord, metafield, and
inventory-delete statements from an application trace inside `BEGIN`/`ROLLBACK`.
Record execution time, rows, shared hit/read blocks, WAL records/bytes, temporary
blocks, and chosen indexes. Do not use `ANALYZE` on destructive statements outside
a rollback-only transaction or disposable Neon branch.
