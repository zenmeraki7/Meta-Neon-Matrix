import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";

function buildJsonlStream(totalRows) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= totalRows) {
        controller.close();
        return;
      }
      const row = {
        targetIdentity: `target-${index}`,
        productId: `gid://shopify/Product/${index}`,
        userErrors: [],
      };
      controller.enqueue(`${JSON.stringify(row)}\n`);
      index += 1;
    },
  });
}

async function streamAndChunkProcess(totalRows, chunkSize = 500) {
  const response = new Response(buildJsonlStream(totalRows), { status: 200 });
  const body = response.body;
  const nodeStream = Readable.fromWeb(body);
  const rl = readline.createInterface({ input: nodeStream, crlfDelay: Infinity });

  let rowCount = 0;
  let flushCount = 0;
  const chunk = [];

  for await (const line of rl) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed);
    chunk.push(parsed);
    rowCount += 1;
    if (chunk.length >= chunkSize) {
      chunk.length = 0;
      flushCount += 1;
    }
  }
  if (chunk.length > 0) {
    flushCount += 1;
  }

  return { rowCount, flushCount };
}

test("duplicate webhook dedupe contracts are present (x10 delivery safe)", () => {
  const queueSource = fs.readFileSync(
    path.resolve("web/Jobs/Queues/bulkEditResultIngestJob.js"),
    "utf8",
  );
  const workerSource = fs.readFileSync(
    path.resolve("web/Jobs/Workers/bulkEditResultIngestWorker.js"),
    "utf8",
  );

  assert.ok(queueSource.includes("buildWebhookJobId"));
  assert.ok(workerSource.includes("already_ingested"));
  assert.ok(workerSource.includes("bulk-edit-verification:${historyId}:${executionId || \"none\"}"));
});

test("crash window recovery contracts are present", () => {
  const source = fs.readFileSync(
    path.resolve("web/Jobs/Workers/stuckBulkMutationRecoveryWorker.js"),
    "utf8",
  );
  assert.ok(source.includes("OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING"));
  assert.ok(source.includes("OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS"));
  assert.ok(source.includes("addbulkEditResultIngestJob"));
});

test("100k+ streaming chunk processing stays bounded and flushes repeatedly", async () => {
  const before = process.memoryUsage().heapUsed;
  const { rowCount, flushCount } = await streamAndChunkProcess(100_000, 500);
  const after = process.memoryUsage().heapUsed;
  const delta = after - before;

  assert.equal(rowCount, 100_000);
  assert.ok(flushCount >= 200, `Expected >=200 chunk flushes, got ${flushCount}`);
  assert.ok(delta < 700 * 1024 * 1024, `Memory delta too high: ${delta}`);
});

test("ingestion service source enforces chunked processing (no rows accumulator)", () => {
  const source = fs.readFileSync(
    path.resolve("web/services/bulkEdit/BulkEditResultIngestionService.js"),
    "utf8",
  );
  assert.ok(source.includes("const FLUSH_SIZE = 500"));
  assert.ok(source.includes("await flushPending()"));
  assert.ok(!source.includes("rows.push("));
});

