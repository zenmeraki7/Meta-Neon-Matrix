-- The first CSV-create fail-closed migration intentionally skipped histories
-- that already had an UndoOperation. A failed zero-progress request can still
-- exist for those histories, so make the immutable history policy authoritative
-- regardless of whether an execution record was previously created.
UPDATE "EditHistory" AS history
SET "undo" = jsonb_set(
  COALESCE(history."undo"::jsonb, '{}'::jsonb),
  '{allowed}',
  'false'::jsonb,
  true
)
WHERE COALESCE((history."undo"->>'allowed')::boolean, false) = true
  AND EXISTS (
    SELECT 1
    FROM "ChangeRecord" AS change
    WHERE change."editHistoryId" = history."id"
      AND change."shop" = history."shop"
      AND COALESCE((change."options"->>'csvCreate')::boolean, false) = true
  );
