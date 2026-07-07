import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SERVICE_SOURCE = fs.readFileSync(
  new URL("./services/productService/productExportService.js", import.meta.url),
  "utf8",
);
const EXPORT_QUEUE_SOURCE = fs.readFileSync(
  new URL("./Jobs/Queues/bulkExportJob.js", import.meta.url),
  "utf8",
);
const EXPORT_WORKER_SOURCE = fs.readFileSync(
  new URL("./Jobs/Workers/bulkExportWorker.js", import.meta.url),
  "utf8",
);
const QUEUE_ADAPTER_SOURCE = fs.readFileSync(
  new URL("./queues/adapters/jobsQueueInstancesAdapter.js", import.meta.url),
  "utf8",
);
const EXPORT_QUEUE_CONSTANTS_SOURCE = fs.readFileSync(
  new URL("./queues/exportQueue.constants.js", import.meta.url),
  "utf8",
);
const SERVER_SOURCE = fs.readFileSync(
  new URL("./server.js", import.meta.url),
  "utf8",
);
const BULK_EXPORT_REPOSITORY_SOURCE = fs.readFileSync(
  new URL("./repositories/bulkExportExecutionRepository.js", import.meta.url),
  "utf8",
);
const WORKER_BOOT_SOURCE = fs.readFileSync(
  new URL("./worker.js", import.meta.url),
  "utf8",
);
const SELECTOR_SOURCE = fs.readFileSync(
  new URL("./services/productService/exportJobSelectors.js", import.meta.url),
  "utf8",
);
const SCHEMA_SOURCE = fs.readFileSync(
  new URL("./prisma/schema.prisma", import.meta.url),
  "utf8",
);
const USE_CASE_SOURCE = fs.readFileSync(
  new URL("./useCases/historyUseCases.js", import.meta.url),
  "utf8",
);

function getExportJobModelFields() {
  const modelMatch = SCHEMA_SOURCE.match(/model\s+ExportJob\s+\{([\s\S]*?)\n\}/);
  assert.ok(modelMatch, "schema.prisma should define model ExportJob");

  return new Set(
    modelMatch[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//") && !line.startsWith("@@"))
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean),
  );
}

function getExportJobSelectFields(selectName) {
  const selectMatch = SELECTOR_SOURCE.match(
    new RegExp(`export const ${selectName} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`),
  );
  assert.ok(selectMatch, `${selectName} should be defined`);

  const spreadSources = [...selectMatch[1].matchAll(/\.\.\.(EXPORT_JOB_[A-Z_]+_SELECT)/g)]
    .flatMap((match) => getExportJobSelectFields(match[1]));
  const directFields = [...selectMatch[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*true,/gm)]
    .map((match) => match[1]);

  return [...spreadSources, ...directFields];
}

test("export history detail query scopes by string exportJobId and authenticated shop", () => {
  assert.match(
    SERVICE_SOURCE,
    /const\s+exportJobId\s*=\s*[\s\S]*input\?\.(?:exportJobId|id)/,
    "ProductExportService should normalize object input to a scalar exportJobId",
  );
  assert.match(
    SERVICE_SOURCE,
    /where:\s*\{\s*id:\s*exportJobId,\s*shop,/,
    "ExportJob detail query must use where: { id: exportJobId, shop }",
  );
  assert.doesNotMatch(
    SERVICE_SOURCE,
    /where:\s*\{\s*id:\s*\{\s*(?:shop|id)\b/,
    "ExportJob detail query must not nest shop/id inside the String id filter",
  );
});

test("history export detail use case passes exportJobId explicitly", () => {
  assert.match(
    USE_CASE_SOURCE,
    /getExportHistoryDetails\(\{\s*shop:\s*command\.shop,\s*exportJobId:\s*command\.id,/,
  );
});

test("export job selects only contain real ExportJob fields", () => {
  const exportJobFields = getExportJobModelFields();
  const selectedFields = new Set([
    ...getExportJobSelectFields("EXPORT_JOB_LIST_SELECT"),
    ...getExportJobSelectFields("EXPORT_JOB_DETAIL_SELECT"),
  ]);

  assert.ok(selectedFields.has("targetSnapshotCount"));
  assert.ok(selectedFields.has("durationMs"));
  assert.ok(selectedFields.has("fields"));
  assert.ok(selectedFields.has("fileUrl"));
  assert.ok(selectedFields.has("error"));

  assert.equal(
    selectedFields.has("processedCount"),
    false,
    "processedCount is derived after query; it is not an ExportJob column",
  );
  assert.equal(
    selectedFields.has("progressPercent"),
    false,
    "progressPercent is derived after query; it is not an ExportJob column",
  );

  for (const field of selectedFields) {
    assert.ok(exportJobFields.has(field), `${field} must exist on model ExportJob`);
  }
});

test("export history detail DTO returns selected fields and display labels", async () => {
  const {
    toExportHistoryDetailResponseDto,
    toExportHistoryListResponseDto,
  } = await import("./dtos/historyDto.js");

  const response = toExportHistoryDetailResponseDto({
    id: "export_1",
    filename: "products-new.csv",
    type: "Manual export",
    status: "PENDING",
    executionState: "QUEUED",
    fields: ["title", "status"],
    totalItems: 0,
  });

  assert.deepEqual(response.data.fields, ["title", "status"]);
  assert.deepEqual(response.data.exportedFields, [
    { key: "title", label: "Title" },
    { key: "status", label: "Status" },
  ]);

  const listResponse = toExportHistoryListResponseDto({
    items: [
      {
        id: "export_1",
        filename: "products.csv",
        type: "Manual Export",
        rawType: "Manual export",
        status: "COMPLETED",
        statusNormalized: "COMPLETED",
        fileUrl: "https://res.cloudinary.com/dpmkrqs2n/raw/upload/v1/product-exports/products.csv",
        totalItems: 1,
        primaryStatus: {
          key: "completed",
          label: "Completed",
          isTerminal: true,
        },
      },
    ],
    totalCount: 1,
  });

  assert.equal(listResponse.data[0].filename, "products.csv");
  assert.equal(listResponse.data[0].fileName, "products.csv");
  assert.equal(listResponse.data[0].rawType, "Manual export");
  assert.equal(listResponse.data[0].downloadReady, true);
  assert.equal(listResponse.data[0].totalItems, 1);
  assert.equal(listResponse.data[0].primaryStatus.isTerminal, true);
});

test("export history list filters match stored Manual export casing", () => {
  assert.match(
    SERVICE_SOURCE,
    /where\.type\s*=\s*\{\s*in:\s*\["Manual export",\s*"manual export",\s*"Manual Export"\]\s*\}/,
    "manual export list filter must include the actual ExportJob.type default casing",
  );
  assert.match(
    SERVICE_SOURCE,
    /where\.type\s*=\s*\{\s*in:\s*\["Scheduled export",\s*"scheduled export",\s*"Scheduled Export"\]\s*\}/,
    "scheduled export list filter must include expected stored casing variants",
  );
  assert.doesNotMatch(
    SERVICE_SOURCE,
    /where\.type\s*=\s*"manual export"/,
    "manual export list filter must not use a single lower-case Postgres equality",
  );
});

test("manual export enqueue marks queued before BullMQ add and releases API shop lock first", () => {
  assert.match(
    SERVICE_SOURCE,
    /executionState:\s*EXPORT_EXECUTION_STATES\.QUEUED[\s\S]*addbulkExportJob/,
    "ExportJob should be visibly queued before the BullMQ job is added",
  );
  assert.match(
    SERVICE_SOURCE,
    /releaseExclusiveShopWork\(writeCatalogLock\?\.lockKey\);\s*writeCatalogLock\s*=\s*null;[\s\S]*addbulkExportJob/,
    "API preparation lock should be released before the export worker attempts to acquire it",
  );
  assert.match(
    SERVICE_SOURCE,
    /jobId:\s*`product-export:\$\{shop\}:\$\{jobId\}`/,
    "Manual export should use a stable BullMQ job id scoped by shop and export job id",
  );
  assert.match(
    SERVICE_SOURCE,
    /failureStage:\s*"queue_enqueue"/,
    "If enqueue fails, the ExportJob should be marked failed instead of remaining pending",
  );
});

test("product export producer, adapter, and worker share one queue identity", () => {
  assert.match(EXPORT_QUEUE_SOURCE, /PRODUCT_EXPORT_JOB_NAME/);
  assert.match(EXPORT_WORKER_SOURCE, /PRODUCT_EXPORT_QUEUE_NAME/);
  assert.match(QUEUE_ADAPTER_SOURCE, /PRODUCT_EXPORT_QUEUE_NAME/);
  assert.doesNotMatch(EXPORT_WORKER_SOURCE, /process\.env\.EXPORT_QUEUE/);
  assert.doesNotMatch(EXPORT_QUEUE_CONSTANTS_SOURCE, /process\.env\.EXPORT_QUEUE/);
  assert.match(EXPORT_QUEUE_CONSTANTS_SOURCE, /PRODUCT_EXPORT_QUEUE_NAME\s*=\s*"bulk-export"/);
});

test("product export worker is bootstrapped and logs lifecycle events", () => {
  assert.match(
    WORKER_BOOT_SOURCE,
    /"\.\/Jobs\/Workers\/bulkExportWorker\.js"/,
    "worker entrypoint must import the bulk export worker",
  );
  assert.match(
    EXPORT_WORKER_SOURCE,
    /new QueueEvents\(QUEUE_NAME/,
    "bulk export worker should subscribe to queue events for waiting/active/stalled/failed visibility",
  );
  assert.match(
    EXPORT_WORKER_SOURCE,
    /Bulk export worker started/,
    "bulk export worker should log startup with the queue name",
  );
  assert.match(
    EXPORT_WORKER_SOURCE,
    /Bulk export worker picked job/,
    "bulk export worker should log when it starts processing a job",
  );
  assert.match(
    EXPORT_WORKER_SOURCE,
    /Bulk export worker received invalid payload/,
    "bulk export worker should log malformed payloads before throwing",
  );
});

test("bulk export worker waits for file finish without missing fast finish events", () => {
  assert.match(
    EXPORT_WORKER_SOURCE,
    /function\s+endCsvAndWaitForFile\(\{\s*csvStream,\s*writeStream\s*\}\)/,
    "bulk export worker should centralize CSV stream finalization",
  );
  assert.match(
    EXPORT_WORKER_SOURCE,
    /writeStream\.once\("finish",\s*resolve\);[\s\S]*csvStream\.end\(\);/,
    "finish listener must be registered before csvStream.end()",
  );
  assert.doesNotMatch(
    EXPORT_WORKER_SOURCE,
    /csvStream\.end\(\);\s*await\s+new Promise/,
    "worker must not call csvStream.end() before attaching writeStream finish listener",
  );
});

test("bulk export worker uses a bounded shop lock ttl", () => {
  const lockServiceSource = fs.readFileSync(
    new URL("./services/shopWorkLeaseService.js", import.meta.url),
    "utf8",
  );

  assert.match(
    lockServiceSource,
    /ttlMs\s*=\s*DEFAULT_LOCK_TTL_MS/,
    "shop work lock service should allow callers to override lock ttl",
  );
  assert.match(
    EXPORT_WORKER_SOURCE,
    /EXPORT_WORKER_LOCK_DURATION_MS\s*\|\|\s*120000/,
    "export worker BullMQ lock duration should recover killed jobs quickly",
  );
  assert.match(
    EXPORT_WORKER_SOURCE,
    /EXPORT_SHOP_WORK_LOCK_TTL_MS\s*\|\|\s*120000/,
    "export worker should use a shorter shop lock ttl so killed jobs unblock quickly",
  );
  assert.match(
    EXPORT_WORKER_SOURCE,
    /ttlMs:\s*SHOP_WORK_LOCK_TTL_MS/,
    "export worker should pass the bounded lock ttl into acquireExclusiveShopWork",
  );
});

test("bulk export worker defers retryable conflicts instead of exhausting the job", () => {
  assert.match(
    EXPORT_WORKER_SOURCE,
    /function\s+deferRetryableExportJob/,
    "export worker should have an explicit retryable deferral path",
  );
  assert.match(
    EXPORT_WORKER_SOURCE,
    /addbulkExportJob\([\s\S]*delay:\s*delayMs[\s\S]*product-export:\$\{shop\}:\$\{exportJobId\}:retry/,
    "retryable export conflicts should be requeued as delayed jobs with unique job ids",
  );
  assert.match(
    EXPORT_WORKER_SOURCE,
    /if\s*\(isRetryableError\(error\)\)\s*\{\s*return\s+deferRetryableExportJob/,
    "retryable export errors should complete the active BullMQ job as deferred, not throw and exhaust attempts",
  );
});

test("bulk export claim can recover the same stalled running job", () => {
  assert.match(
    BULK_EXPORT_REPOSITORY_SOURCE,
    /isRecoverableSameJobRun/,
    "claimExportJobExecution should detect same-job PROCESSING/RUNNING recovery",
  );
  assert.match(
    BULK_EXPORT_REPOSITORY_SOURCE,
    /normalizeExportJobStatus\("PROCESSING"\)[\s\S]*isRecoverableSameJobRun/,
    "same-job recovery should allow PROCESSING status to be claimed",
  );
  assert.match(
    BULK_EXPORT_REPOSITORY_SOURCE,
    /normalizeExportJobExecutionState\(EXPORT_EXECUTION_STATES\.RUNNING\)[\s\S]*isRecoverableSameJobRun/,
    "same-job recovery should allow RUNNING execution state to be claimed",
  );
  assert.match(
    BULK_EXPORT_REPOSITORY_SOURCE,
    /fileUrl:\s*null/,
    "same-job running recovery should only reclaim jobs without an uploaded file",
  );
});

test("server loads dotenv before importing app graph", () => {
  assert.match(
    SERVER_SOURCE,
    /^import\s+"dotenv\/config";/,
    "server.js must load dotenv as a side-effect import before app/routes/services are imported",
  );
  assert.doesNotMatch(
    SERVER_SOURCE,
    /dotenv\.config\(\);/,
    "dotenv.config() after static imports is too late for queue constants",
  );
});
