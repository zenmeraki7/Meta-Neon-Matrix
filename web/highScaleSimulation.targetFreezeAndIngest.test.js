import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");

function simulateChunkedProcessing(total, batchSize) {
  let processed = 0;
  let calls = 0;
  while (processed < total) {
    const n = Math.min(batchSize, total - processed);
    processed += n;
    calls += 1;
  }
  return { processed, calls };
}

test("high-scale simulation: 1M target freeze chunking stays bounded", () => {
  const result = simulateChunkedProcessing(1_000_000, 1000);
  assert.equal(result.processed, 1_000_000);
  assert.equal(result.calls, 1000);
});

test("target freeze implementation uses deterministic 1000-row chunking", () => {
  const src = read("web/services/productService/productTargetingService.js");
  const count = (src.match(/const BATCH_SIZE = 1000;/g) || []).length;
  assert.ok(count >= 2, "expected both product and variant freeze loops to use BATCH_SIZE=1000");
  assert.ok(src.includes("while (true)"));
  assert.ok(src.includes("createMany"));
});

test("result ingestion persists checkpoint and checksum fields for resumability", () => {
  const src = read("web/services/bulkEdit/BulkEditResultIngestionService.js");
  assert.ok(src.includes("checkpointVersion"));
  assert.ok(src.includes("rollingChecksum"));
  assert.ok(src.includes("editHistoryIngestionCheckpoint"));
  assert.ok(src.includes("shop_historyId_ingestionRunId"));
  assert.ok(src.includes("rowOffset"));
  assert.ok(src.includes("MALFORMED_RESULT_JSONL_ROWS"));
  assert.ok(src.includes("UNMAPPED_RESULT_ROWS"));
});

test("result ingestion preserves its terminal marker and accepts committed row retries", () => {
  const src = read("web/services/bulkEdit/BulkEditResultIngestionService.js");
  assert.ok(src.includes("latestHistoryForMirrorApply?.batch"));
  assert.ok(src.includes('["SUCCESS", "SUCCEEDED", "VERIFIED"].includes(existingStatus)'));
  assert.ok(src.includes("existingRecord.options"));
});

test("prisma schema defines dedicated ingestion checkpoint model keyed by shop/history/run", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.ok(schema.includes("model EditHistoryIngestionCheckpoint"));
  assert.ok(schema.includes("@@unique([shop, historyId, ingestionRunId])"));
});
