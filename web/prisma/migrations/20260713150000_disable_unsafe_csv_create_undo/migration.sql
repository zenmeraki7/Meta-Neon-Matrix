-- Historical CSV-create operations could be marked undoable before the import
-- worker began disabling undo for product creates. They contain synthetic target
-- ids rather than immutable Shopify product GIDs, so fail closed and hide Undo.
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
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "UndoOperation" AS undo_operation
    WHERE undo_operation."shop" = history."shop"
      AND undo_operation."sourceEditHistoryId" = history."id"
  );
