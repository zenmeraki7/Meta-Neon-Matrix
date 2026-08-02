import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
  normalizeExportJobExecutionState,
} from "./utils/normalizedStateUtils.js";
import {
  requireVariantGid,
  variantGidFromVerifiedLegacyId,
} from "./utils/shopifyVariantGid.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("normalized execution state retains authoritative workflow stage", () => {
  assert.equal(normalizeEditHistoryExecutionState("TARGET_FREEZING"), "TARGET_FREEZING");
  assert.equal(normalizeEditHistoryExecutionState("VERIFYING"), "VERIFYING");
  assert.equal(normalizeEditHistoryExecutionState("PARTIAL_FAILED"), "PARTIAL_FAILED");
  assert.equal(normalizeEditHistoryStatus("cancelled"), "CANCELLED");
  assert.equal(normalizeExportJobExecutionState("paused"), "PAUSED");
});

test("variant identity conversion never uses JavaScript Number", () => {
  const legacy = 9007199254740993123456789n;
  const gid = variantGidFromVerifiedLegacyId(legacy);
  assert.equal(gid, "gid://shopify/ProductVariant/9007199254740993123456789");
  assert.equal(requireVariantGid(gid), gid);
  assert.throws(() => requireVariantGid("9007199254740993"), /canonical Shopify/);

  const repository = read("db/variantMetafields.js");
  const ledger = read("db/bulkEditChanges.js");
  const worker = read("Jobs/Workers/metafieldBulkWriteWorker.js");
  assert.doesNotMatch(repository, /BigInt\(row\.variantId\)/);
  assert.doesNotMatch(ledger, /BigInt\([^)]*variant/);
  assert.match(worker, /LEGACY_VARIANT_IDENTITY_QUEUE_PAYLOAD_REJECTED/);
  assert.match(worker, /requireVariantGid\(row\.variant_gid\)/);
});

test("generic counters are no longer written by workflow services", () => {
  const progress = read("services/operationStageProgressService.js");
  const ingest = read("Jobs/Workers/bulkEditResultIngestWorker.js");
  const verify = read("services/bulkEdit/BulkEditVerificationService.js");
  for (const source of [progress, ingest, verify]) {
    assert.doesNotMatch(source, /counterA\s*:/);
    assert.doesNotMatch(source, /counterB\s*:/);
    assert.doesNotMatch(source, /counterC\s*:/);
  }
  assert.match(progress, /succeededItemCount/);
  assert.match(progress, /failedItemCount/);
  assert.match(progress, /observedItemCount/);
});

test("migration audits mismatches and enforces compatibility projections", () => {
  const migration = read(
    "prisma/migrations/20260801140000_normalized_authority_progress_variant_gid/migration.sql",
  );
  assert.match(migration, /LegacyStateMismatchAudit/);
  assert.match(migration, /normalized_state_projection_trg/);
  assert.match(migration, /variant_metafields_shop_id_variant_gid_namespace_key_key/);
  assert.match(migration, /LegacyOperationStageCounterClassification/);
  assert.match(migration, /named_counts_nonnegative_ck/);
});
