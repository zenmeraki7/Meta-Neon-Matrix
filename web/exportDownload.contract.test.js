import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import {
  ExportDownloadError,
  buildContentDisposition,
  findDownloadableExport,
  sanitizeAttachmentFilename,
  streamExportCsvDownload,
  validateStoredCloudinaryUrl,
} from "./services/productExport/exportDownloadService.js";

const VALID_URL =
  "https://res.cloudinary.com/dpmkrqs2n/raw/upload/v1783333873/product-exports/products.csv";

function createDb(exportJob = null) {
  return {
    exportJob: {
      async findFirst(query) {
        createDb.lastQuery = query;
        return exportJob;
      },
    },
  };
}

class MemoryResponse extends Writable {
  constructor() {
    super();
    this.headers = new Map();
    this.statusCode = 0;
    this.body = Buffer.alloc(0);
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(name.toLowerCase());
  }

  _write(chunk, _encoding, callback) {
    this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
    callback();
  }
}

function makeExportJob(overrides = {}) {
  return {
    id: "export_1",
    shop: "demo-zen-store.myshopify.com",
    filename: "products.csv",
    downloadUrl: VALID_URL,
    status: "COMPLETED",
    statusNormalized: "COMPLETED",
    executionState: "COMPLETED",
    executionStateNormalized: "COMPLETED",
    ...overrides,
  };
}

function makeCsvResponse(csv, { status = 200 } = {}) {
  return new Response(csv, {
    status,
    headers: { "content-type": "text/csv; charset=utf-8" },
  });
}

test("export download lookup is scoped by authenticated shop and export id", async () => {
  const db = createDb(makeExportJob());
  const exportJob = await findDownloadableExport({
    exportJobId: "export_1",
    shop: "demo-zen-store.myshopify.com",
    db,
  });

  assert.equal(exportJob.id, "export_1");
  assert.deepEqual(createDb.lastQuery.where, {
    id: "export_1",
    shop: "demo-zen-store.myshopify.com",
  });
});

test("different shop cannot download export and receives safe not found", async () => {
  await assert.rejects(
    () =>
      findDownloadableExport({
        exportJobId: "export_1",
        shop: "other-shop.myshopify.com",
        db: createDb(null),
      }),
    (error) =>
      error instanceof ExportDownloadError &&
      error.code === "EXPORT_NOT_FOUND" &&
      error.statusCode === 404,
  );
});

test("non-completed export cannot be downloaded", async () => {
  await assert.rejects(
    () =>
      findDownloadableExport({
        exportJobId: "export_1",
        shop: "demo-zen-store.myshopify.com",
        db: createDb(makeExportJob({ status: "PROCESSING", statusNormalized: "PROCESSING" })),
      }),
    (error) => error.code === "EXPORT_NOT_READY" && error.statusCode === 409,
  );
});

test("missing Cloudinary asset reference is handled without proxying arbitrary URLs", async () => {
  await assert.rejects(
    () =>
      findDownloadableExport({
        exportJobId: "export_1",
        shop: "demo-zen-store.myshopify.com",
        db: createDb(makeExportJob({ downloadUrl: null })),
      }),
    (error) =>
      error.code === "EXPORT_FILE_REFERENCE_MISSING" &&
      error.statusCode === 409,
  );
});

test("stored URL validation only allows Cloudinary raw HTTPS delivery", () => {
  assert.equal(validateStoredCloudinaryUrl(VALID_URL), VALID_URL);
  assert.throws(
    () => validateStoredCloudinaryUrl("http://res.cloudinary.com/dpm/raw/upload/file.csv"),
    /EXPORT_FILE_REFERENCE_UNSAFE|Export file reference is invalid/,
  );
  assert.throws(
    () => validateStoredCloudinaryUrl("https://example.com/file.csv"),
    /EXPORT_FILE_REFERENCE_UNSAFE|Export file reference is invalid/,
  );
  assert.throws(
    () => validateStoredCloudinaryUrl("https://res.cloudinary.com/dpm/image/upload/file.csv"),
    /EXPORT_FILE_REFERENCE_UNSAFE|Export file reference is invalid/,
  );
});

test("filename and Content-Disposition are sanitized against header injection", () => {
  assert.equal(sanitizeAttachmentFilename("../bad\r\nname.csv"), "badname.csv");
  const header = buildContentDisposition('products "summer", ю.csv');
  assert.match(header, /^attachment; filename="/);
  assert.ok(header.includes("filename*=UTF-8''"));
  assert.doesNotMatch(header, /[\r\n]/);
});

test("completed export streams CSV with attachment headers and preserves CSV bytes", async () => {
  const csv = 'Title,Vendor\n"Comma, Product","Zen"\n"Line\nBreak","UTF-8 Café"\n';
  const res = new MemoryResponse();
  let fetchedUrl = null;

  await streamExportCsvDownload({
    exportJobId: "export_1",
    shop: "demo-zen-store.myshopify.com",
    res,
    db: createDb(makeExportJob({ filename: 'products "final".csv' })),
    fetchImpl: async (url) => {
      fetchedUrl = url;
      return makeCsvResponse(csv);
    },
  });

  assert.equal(fetchedUrl, VALID_URL);
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("content-type"), "text/csv; charset=utf-8");
  assert.equal(res.getHeader("x-content-type-options"), "nosniff");
  assert.equal(res.getHeader("cache-control"), "private, no-store");
  assert.match(res.getHeader("content-disposition"), /attachment/);
  assert.match(res.getHeader("content-disposition"), /products final\.csv/);
  assert.equal(res.body.toString("utf8"), csv);
});

test("Cloudinary 404 and 500 map to gateway-safe failures", async () => {
  for (const [status, expectedStatus] of [
    [404, 404],
    [500, 502],
  ]) {
    await assert.rejects(
      () =>
        streamExportCsvDownload({
          exportJobId: "export_1",
          shop: "demo-zen-store.myshopify.com",
          res: new MemoryResponse(),
          db: createDb(makeExportJob()),
          fetchImpl: async () => makeCsvResponse("missing", { status }),
        }),
      (error) =>
        error.code === "EXPORT_FILE_UPSTREAM_UNAVAILABLE" &&
        error.statusCode === expectedStatus,
    );
  }
});

test("Cloudinary timeout is handled as 504", async () => {
  await assert.rejects(
    () =>
      streamExportCsvDownload({
        exportJobId: "export_1",
        shop: "demo-zen-store.myshopify.com",
        res: new MemoryResponse(),
        db: createDb(makeExportJob()),
        timeoutMs: 1,
        fetchImpl: (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason));
          }),
      }),
    (error) => error.code === "EXPORT_FILE_TIMEOUT" && error.statusCode === 504,
  );
});

test("frontend download path no longer calls or exposes Cloudinary directly", () => {
  const sourcePath = path.join(
    process.cwd(),
    "web/frontend/pages/ExportDetails/[id].jsx",
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.ok(source.includes("/api/products/download-export/"));
  assert.ok(source.includes("authenticatedFetch("));
  assert.doesNotMatch(source, /res\.cloudinary\.com|downloadUrl|downloadUrl/);
});
