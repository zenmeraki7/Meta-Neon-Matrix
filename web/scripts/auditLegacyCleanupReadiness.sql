-- Read-only Neon/PostgreSQL evidence for the cleanup items that cannot be
-- decided safely from schema inspection alone. Run against the writer branch
-- after pg_stat_user_indexes has observed a representative workload window.

-- Narrow or overlapping indexes with no observed scans, largest first.
SELECT
  schemaname,
  relname AS table_name,
  indexrelname AS index_name,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
  pg_get_indexdef(indexrelid) AS definition
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC, relname, indexrelname;

-- Structurally overlapping indexes whose key columns are a left prefix of a
-- wider index on the same table. Partial predicates are displayed and must
-- match before treating a pair as redundant.
WITH indexes AS (
  SELECT
    i.indrelid,
    i.indexrelid,
    c.relname AS table_name,
    ci.relname AS index_name,
    i.indisunique,
    string_to_array(i.indkey::text, ' ')::smallint[] AS key_columns,
    pg_get_expr(i.indpred, i.indrelid) AS predicate,
    pg_relation_size(i.indexrelid) AS bytes
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_class ci ON ci.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND i.indisvalid AND i.indisready
)
SELECT
  narrow.table_name,
  narrow.index_name AS narrow_index,
  wider.index_name AS wider_index,
  narrow.indisunique AS narrow_unique,
  narrow.predicate AS narrow_predicate,
  wider.predicate AS wider_predicate,
  pg_size_pretty(narrow.bytes) AS removable_size_candidate
FROM indexes narrow
JOIN indexes wider
  ON wider.indrelid = narrow.indrelid
 AND wider.indexrelid <> narrow.indexrelid
 AND cardinality(wider.key_columns) > cardinality(narrow.key_columns)
 AND wider.key_columns[1:cardinality(narrow.key_columns)] = narrow.key_columns
ORDER BY narrow.bytes DESC, narrow.table_name, narrow.index_name;

-- Raw/normalized lifecycle pairs. Review every observed mapping before raw
-- string removal; names are not assumed to be textually identical.
SELECT 'EditHistory.status' AS projection,
       "status" AS raw_value,
       "statusNormalized"::text AS normalized_value,
       COUNT(*) AS row_count
FROM "EditHistory"
GROUP BY "status", "statusNormalized"
UNION ALL
SELECT 'EditHistory.executionState',
       "executionState", "executionStateNormalized"::text, COUNT(*)
FROM "EditHistory"
GROUP BY "executionState", "executionStateNormalized"
UNION ALL
SELECT 'ExportJob.status',
       "status", "statusNormalized"::text, COUNT(*)
FROM "ExportJob"
GROUP BY "status", "statusNormalized"
UNION ALL
SELECT 'ExportJob.executionState',
       "executionState", "executionStateNormalized"::text, COUNT(*)
FROM "ExportJob"
GROUP BY "executionState", "executionStateNormalized"
UNION ALL
SELECT 'OutboxEvent.status',
       "status", "statusNormalized"::text, COUNT(*)
FROM "OutboxEvent"
GROUP BY "status", "statusNormalized"
UNION ALL
SELECT 'WebhookDelivery.status',
       "status", "statusNormalized"::text, COUNT(*)
FROM "WebhookDelivery"
GROUP BY "status", "statusNormalized"
ORDER BY projection, raw_value, normalized_value;

-- Scheduler definition/state divergence. Any row blocks dropping definition
-- scheduling fields or moving scheduler reads without a repair migration.
SELECT COUNT(*) AS divergent_automatic_rule_schedules
FROM "AutomaticProductRule" rule
LEFT JOIN "AutomaticProductRuleScheduleState" state
  ON state."shop" = rule."shop" AND state."automaticProductRuleId" = rule."id"
WHERE state."automaticProductRuleId" IS NULL
   OR state."ruleRevision" <> rule."revision"
   OR state."nextRunAt" IS DISTINCT FROM rule."nextRunAt"
   OR state."scheduleConfig" IS DISTINCT FROM COALESCE(rule."scheduleConfig", rule."scheduleJson")
   OR state."disabledAt" IS DISTINCT FROM rule."schedulerDisabledAt";
