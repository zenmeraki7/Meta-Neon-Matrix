import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const baselinePath = path.join(root, "web", "scripts", "operational-naming-baseline.json");
const updateBaseline = process.argv.includes("--update-baseline");
const sourceExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".prisma"]);
const ignoredDirectories = new Set([".git", "generated", "node_modules", "migrations"]);
const ignoredFiles = new Set([
  "web/scripts/auditOperationalNaming.js",
  "web/scripts/operational-naming-baseline.json",
  "web/tenantIdentityTerminology.contract.test.js",
]);

export const FORBIDDEN_OPERATIONAL_KEYS = new Set([
  "shopId",
  "shop",
  "shopUrl",
  "shopifyDomain",
  "syncBatchId",
  "_id",
  "adminGraphqlApiId",
  "shopifyProductId",
  "idempotencyKey",
  "executionKey",
  "executionIdentity",
  "dedupeKey",
  "fingerprint",
  "operationId",
  "runId",
  "bulkJobId",
  "bulkOperationId",
  "type",
  "scope",
  "state",
]);

export const ALLOWED_CANONICAL_KEYS = new Set([
  "storeId",
  "shopDomain",
  "mirrorBatchId",
  "syncHistoryId",
  "productId",
  "variantId",
  "inventoryItemId",
  "locationId",
  "rowKey",
  "requestIdempotencyKey",
  "executionId",
  "executionDedupeKey",
  "commandHash",
  "dispatchDedupeKey",
  "eventDedupeKey",
  "ruleConfigHash",
  "targetDefinitionHash",
  "normalizedFilterHash",
  "targetRowHash",
  "fileChecksum",
  "rowChecksum",
  "ingestionRollingChecksum",
  "targetSetHash",
  "payloadHash",
  "bulkApplyJobId",
  "shopifyBulkOperationId",
  "automaticRuleRunId",
  "recurringEditRunId",
  "scheduledExportRunId",
  "ingestionRunId",
  "aggregateType",
  "aggregateId",
  "ownerType",
  "ownerId",
  "entityType",
  "entityId",
  "resourceType",
  "resourceId",
  "sourceType",
  "sourceId",
  "outcomeStatus",
  "executionState",
  "stage",
  "healthState",
  "shopifyStatus",
  "dispatchStatus",
  "metafieldType",
  "editType",
  "exportType",
  "filterTrackType",
  "errorType",
  "anomalyType",
  "oauthScopes",
  "changeScope",
  "actorDisplayName",
  "createdByActorId",
  "updatedByActorId",
  "deletedByActorId",
  "pausedByActorId",
  "resumedByActorId",
  "cancelledByActorId",
  "requestedAt",
  "queuedAt",
  "dispatchedAt",
  "startedAt",
  "completedAt",
  "scheduledFor",
  "failureCode",
  "failureMessage",
  "failureStage",
  "failureDetails",
  "failedAt",
  "lastFailureCode",
  "lastFailureMessage",
  "lastFailureAt",
  "selectedFieldKeys",
  "plannedMutation",
  "appliedFieldChanges",
  "affectedFieldKeys",
  "rawFilterInput",
  "filterAst",
  "normalizedFilterAst",
  "canonicalFilterKey",
  "changeSource",
  "triggerSource",
  "ingestionSource",
  "sourceEventType",
  "sourceSystem",
  "sourceEntityUpdatedAt",
  "sourceEventOccurredAt",
  "sourceEventReceivedAt",
  "mirrorMutationSequence",
  "tombstoneMutationSequence",
  "replayStartSequence",
  "replayFinalizedThroughSequence",
  "currentProductMirrorBatchId",
  "currentCollectionMirrorBatchId",
  "expectedPreviousActiveBatchId",
  "targetProductMirrorBatchId",
  "processingChunkId",
  "shopifySubmissionBatchId",
  "commandType",
  "queueName",
  "queueRoutingKey",
  "queueJobName",
  "queueJobId",
  "availableAt",
  "dispatchAttemptCount",
  "domainEventType",
  "workflowStageKey",
  "mirrorResourceType",
  "syncResourceType",
  "fingerprintResourceType",
  "targetResolutionMode",
  "targetResourceType",
  "targetGranularity",
  "targetFreezeMode",
  "beforeValues",
  "afterValues",
  "undoMutation",
  "originalFilename",
  "generatedFilename",
  "storageKey",
  "downloadUrl",
  "shopifyStagedUploadPath",
  "sourceResponseUrl",
  "installationStatus",
  "deletedAt",
  "legacyIsDeleted",
  "legacyIsUninstalled",
  "legacyActive",
]);

const TOKEN_RULES = Object.freeze({
  ambiguous_shop_id: /shopId/i,
  legacy_shop_url: /\bshopUrl\b/,
  legacy_shopify_domain: /\bshopifyDomain\b/,
  legacy_sync_batch_id: /\bsyncBatchId\b/,
  legacy_admin_graphql_id: /\badminGraphqlApiId\b/,
  legacy_shopify_product_id: /\bshopifyProductId\b/,
  mongo_compat_id: /\b_id\b/,
  generic_idempotency_key: /\bidempotencyKey\b/,
  generic_execution_key: /\bexecutionKey\b/,
  generic_execution_identity: /\bexecutionIdentity\b/,
  generic_dedupe_key: /\bdedupeKey\b/,
  generic_fingerprint: /\bfingerprint\b/,
  ambiguous_operation_id: /\boperationId\b/,
  ambiguous_run_id: /\brunId\b/,
  ambiguous_bulk_job_id: /\bbulkJobId\b/,
  ambiguous_bulk_operation_id: /\bbulkOperationId\b/,
  unqualified_type_key: /^\s*type\s*:/,
  unqualified_scope_key: /^\s*scope\s*:/,
  unqualified_state_key: /^\s*state\s*:/,
  legacy_actor_name: /\bactorName\b/,
  legacy_edit_time: /\beditTime\b/,
  generic_created_by: /^\s*createdBy\s*:/,
  generic_updated_by: /^\s*updatedBy\s*:/,
  generic_cancelled_by: /^\s*cancelledBy\s*:/,
  generic_fields_key: /^\s*fields\s*:/,
  generic_affected_fields: /\baffectedFields\b/,
  legacy_filter_params: /\bfilterParams\b/,
  legacy_query_filter: /\bqueryFilter\b/,
  legacy_filter_query: /\bfilterQuery\b/,
  legacy_filter_ast_json: /\bfilterAstJson\b/,
  ambiguous_target_mode: /\btargetMode\b/,
  ambiguous_targeting_mode: /\btargetingMode\b/,
  ambiguous_scope_type: /\bscopeType\b/,
  ambiguous_target_type: /\btargetType\b/,
  ambiguous_file_url: /\bfileUrl\b/,
  ambiguous_response_url: /\bresponseUrl\b/,
  ambiguous_undo_payload: /\bundoPayload\b/,
  ambiguous_is_deleted: /\bisDeleted\b/,
  ambiguous_is_uninstalled: /\bisUninstalled\b/,
  unqualified_active_key: /^\s*active\s*:/,
  legacy_config_fingerprint: /\bconfigFingerprint\b/,
  legacy_targeting_fingerprint: /\btargetingFingerprint\b/,
  legacy_target_fingerprint: /\btargetFingerprint\b/,
  ambiguous_filter_hash: /\bfilterHash\b/,
  ambiguous_checksum_key: /^\s*checksum\s*:/,
  ambiguous_rolling_checksum: /\brollingChecksum\b/,
  ambiguous_source_kind: /\b(?:sourceKind|lastSourceKind|latestSourceKind)\b/,
  ambiguous_source_event_time: /\b(?:sourceEventAt|lastSourceEventAt|latestEventAt)\b/,
  ambiguous_source_updated_time: /\b(?:sourceUpdatedAt|lastSourceUpdatedAt|latestSourceUpdatedAt)\b/,
  ambiguous_mirror_sequence: /\b(?:mutationSequence|syncStartSequence|finalizedSequence)\b/,
  ambiguous_active_batch: /\b(?:activeMirrorBatchId|activeCollectionBatchId|expectedActiveBatchId|targetMirrorBatchId)\b/,
  ambiguous_processing_batch: /\bprocessingBatchId\b/,
  unqualified_batch_id_key: /^\s*batchId\s*:/,
  ambiguous_operation_name: /\boperationName\b/,
  ambiguous_job_name: /\bjobName\b/,
  ambiguous_event_type: /\beventType\b/,
  ambiguous_stage_key: /\bstageKey\b/,
  ambiguous_queue_key: /\bqueueKey\b/,
  ambiguous_run_at: /\brunAt\b/,
  ambiguous_dispatch_owner: /\bdispatchOwner\b/,
  ambiguous_reconciled_at: /\b(?:lastReconciledAt|reconciledAt)\b/,
  ambiguous_last_synced_at: /\blastSyncedAt\b/,
});

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function isAllowedCompatibilityDeclaration(file, line) {
  if (file === "web/prisma/schema.prisma") return true;
  if (file === "web/migrate-mongo-to-neon.mjs") return true;
  if (/serializeLegacy[A-Za-z]*\s*\(/.test(line)) return true;
  return false;
}

function normalizeLine(line) {
  return line.trim().replace(/\s+/g, " ");
}

function scan() {
  const findings = [];
  let compatibilityCount = 0;
  for (const absolute of walk(root)) {
    const file = relative(absolute);
    if (ignoredFiles.has(file)) continue;
    const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [rule, expression] of Object.entries(TOKEN_RULES)) {
        if (!expression.test(line)) continue;
        if (isAllowedCompatibilityDeclaration(file, line)) {
          compatibilityCount += 1;
          continue;
        }
        findings.push({ file, line: index + 1, rule, text: normalizeLine(line) });
      }

      const isOperationalBoundary = /(?:^|\/)(?:Jobs\/Queues|normalizers|commands)(?:\/|$)/.test(file);
      if (isOperationalBoundary && /(?:\bshop\s*:|\bshop\s*,|data\??\.shop\b)/.test(line)) {
        findings.push({
          file,
          line: index + 1,
          rule: "forbidden_operational_shop_key",
          text: normalizeLine(line),
        });
      }

      const isMirrorDto = /(?:^|\/)dtos\/(?:product|variant)[^/]*\.(?:js|ts)$/.test(file);
      if (isMirrorDto && /^\s*id\s*:/.test(line) && !/id:\s*(?:productId|variantId)/.test(line)) {
        findings.push({
          file,
          line: index + 1,
          rule: "ambiguous_mirror_dto_id",
          text: normalizeLine(line),
        });
      }
    });
  }
  return { findings, compatibilityCount };
}

function fingerprint(finding) {
  return `${finding.file}|${finding.rule}|${finding.text}`;
}

function counts(findings) {
  const result = {};
  for (const finding of findings) {
    const key = fingerprint(finding);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

const { findings, compatibilityCount } = scan();
const current = counts(findings);

if (updateBaseline) {
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify({ version: 1, findings: current }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Operational naming baseline updated (${findings.length} debt occurrences; ${compatibilityCount} allowed declarations).`);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error("Naming baseline is missing. Run npm run audit:naming:update-baseline intentionally.");
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")).findings || {};
const additions = findings.filter((finding) => current[fingerprint(finding)] > (baseline[fingerprint(finding)] || 0));
const uniqueAdditions = [...new Map(additions.map((item) => [fingerprint(item), item])).values()];

if (uniqueAdditions.length) {
  console.error("Operational naming contract violated. Use storeId, shopDomain, mirrorBatchId, productId, variantId, or rowKey:");
  for (const item of uniqueAdditions) {
    console.error(`- ${item.file}:${item.line} [${item.rule}] ${item.text}`);
  }
  process.exit(1);
}

console.log(`Operational naming audit passed (${findings.length} baselined debt occurrences; ${compatibilityCount} allowed declarations).`);
