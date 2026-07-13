-- A stale queue retry may have executed after CSV-create histories were marked
-- non-undoable. productSet can succeed by re-applying the created product, which
-- is not an undo. Reconcile those executions to an explicit failed terminal
-- state, preserve the product, and leave an immutable recovery audit.
INSERT INTO "BulkEditRecoveryAudit" (
  "id",
  "shop",
  "historyId",
  "mode",
  "reason",
  "actorType",
  "result",
  "metadata",
  "createdAt"
)
SELECT
  'unsafe_csv_undo_reconcile_' || history."id",
  history."shop",
  history."id",
  'UNSAFE_CSV_CREATE_UNDO_RECONCILIATION',
  'CSV-created products have no immutable pre-create Shopify resource state to restore',
  'DATABASE_MIGRATION',
  'FAILED_CLOSED',
  jsonb_build_object('operationKey', 'CSV_IMPORT_SET'),
  NOW()
FROM "EditHistory" AS history
WHERE EXISTS (
  SELECT 1
  FROM "ChangeRecord" AS change
  WHERE change."editHistoryId" = history."id"
    AND change."shop" = history."shop"
    AND COALESCE((change."options"->>'csvCreate')::boolean, false) = true
)
AND EXISTS (
  SELECT 1
  FROM "UndoOperation" AS undo_operation
  WHERE undo_operation."shop" = history."shop"
    AND undo_operation."sourceEditHistoryId" = history."id"
)
ON CONFLICT ("id") DO NOTHING;

UPDATE "UndoOperation" AS operation
SET
  "status" = 'failed',
  "state" = 'failed',
  "bulkOperationId" = NULL,
  "processedCount" = 0,
  "restoredCount" = 0,
  "failedCount" = 1,
  "errorCode" = 'CSV_CREATE_UNDO_NOT_SUPPORTED',
  "errorMessage" = 'CSV imports that created products cannot be safely undone',
  "completedAt" = COALESCE(operation."completedAt", NOW()),
  "updatedAt" = NOW()
WHERE EXISTS (
  SELECT 1
  FROM "ChangeRecord" AS change
  WHERE change."editHistoryId" = operation."sourceEditHistoryId"
    AND change."shop" = operation."shop"
    AND COALESCE((change."options"->>'csvCreate')::boolean, false) = true
);

UPDATE "EditHistory" AS history
SET "undo" = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(history."undo"::jsonb, '{}'::jsonb),
          '{allowed}',
          'false'::jsonb,
          true
        ),
        '{status}',
        '"failed"'::jsonb,
        true
      ),
      '{state}',
      '"failed"'::jsonb,
      true
    ),
    '{processedCount}',
    '0'::jsonb,
    true
  ),
  '{error}',
  jsonb_build_object(
    'code', 'csv_create_undo_not_supported',
    'stage', 'eligibility_reconciliation',
    'message', 'CSV imports that created products cannot be safely undone',
    'retryable', false,
    'occurredAt', NOW()
  ),
  true
)
WHERE EXISTS (
  SELECT 1
  FROM "ChangeRecord" AS change
  WHERE change."editHistoryId" = history."id"
    AND change."shop" = history."shop"
    AND COALESCE((change."options"->>'csvCreate')::boolean, false) = true
)
AND EXISTS (
  SELECT 1
  FROM "UndoOperation" AS undo_operation
  WHERE undo_operation."shop" = history."shop"
    AND undo_operation."sourceEditHistoryId" = history."id"
);
