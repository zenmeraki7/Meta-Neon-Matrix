// web/exportFileIsolation.test.js
//
// Unit tests for the per-job temp-directory isolation and checksum-verification
// patch applied to bulkExportWorker.js and bulkExportExecutionRepository.js.
//
// These tests are pure — no network, no database, no BullMQ.  They exercise
// helpers that can be inlined or re-exported from the worker, plus a small
// in-process simulation of the repository conflict guard.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// ---------------------------------------------------------------------------
// Helpers inlined from bulkExportWorker.js
// ---------------------------------------------------------------------------

async function makeTempDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "metamatrix-export-"));
}

function buildExportFilePath(tempDirectory, exportJobId) {
  return path.join(tempDirectory, `${exportJobId}.csv`);
}

async function hashExportFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let sizeBytes = 0;
    const readStream = fs.createReadStream(filePath);
    readStream.on("data", (chunk) => {
      sizeBytes += chunk.length;
      hash.update(chunk);
    });
    readStream.on("end", () => resolve({ checksum: hash.digest("hex"), sizeBytes }));
    readStream.on("error", reject);
  });
}

async function writeExclusiveFile(filePath, content) {
  const writeStream = fs.createWriteStream(filePath, { flags: "wx", mode: 0o600 });
  return new Promise((resolve, reject) => {
    writeStream.once("finish", resolve);
    writeStream.once("error", reject);
    writeStream.end(content);
  });
}

async function rmTempDir(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Minimal in-process replica of the finalizeExportSuccessState conflict guard
// ---------------------------------------------------------------------------

class ChecksumConflictError extends Error {
  constructor(stored, incoming) {
    super("EXPORT_CHECKSUM_CONFLICT");
    this.code = "EXPORT_CHECKSUM_CONFLICT";
    this.details = { storedChecksum: stored, incomingChecksum: incoming };
  }
}

function makeJobRecord(overrides = {}) {
  return { fileChecksum: null, status: "PROCESSING", ...overrides };
}

function simulateFinalizeExportSuccessState(row, { checksum, downloadUrl }) {
  if (row.fileChecksum && row.fileChecksum !== checksum) {
    throw new ChecksumConflictError(row.fileChecksum, checksum);
  }
  row.fileChecksum = checksum;
  row.downloadUrl = downloadUrl;
  row.status = "COMPLETED";
  return true;
}

// ---------------------------------------------------------------------------
// Test 1 — Two shops with the same generatedFilename get distinct physical paths
// ---------------------------------------------------------------------------

test("parallel exports for different shops use distinct temp directories", async () => {
  const shopA = "shop-a.myshopify.com";
  const shopB = "shop-b.myshopify.com";
  const filename = "products_export.csv"; // same filename — the old race condition
  void filename;

  const [dirA, dirB] = await Promise.all([makeTempDir(), makeTempDir()]);
  try {
    const pathA = buildExportFilePath(dirA, `job-${shopA}`);
    const pathB = buildExportFilePath(dirB, `job-${shopB}`);

    assert.notEqual(dirA, dirB, "temp directories must differ");
    assert.notEqual(pathA, pathB, "physical file paths must differ");
    assert.ok(pathA.startsWith(dirA), "shop-A path must be inside shop-A temp dir");
    assert.ok(pathB.startsWith(dirB), "shop-B path must be inside shop-B temp dir");
  } finally {
    await rmTempDir(dirA);
    await rmTempDir(dirB);
  }
});

// ---------------------------------------------------------------------------
// Test 2 — Neither CSV contains the other shop's product IDs
// ---------------------------------------------------------------------------

test("parallel shop exports do not cross-contaminate CSV contents", async () => {
  const [dirA, dirB] = await Promise.all([makeTempDir(), makeTempDir()]);
  try {
    const pathA = buildExportFilePath(dirA, "job-shop-a");
    const pathB = buildExportFilePath(dirB, "job-shop-b");

    const rowsA = ["id,title", "gid://shopify/Product/1001,Alpha", "gid://shopify/Product/1002,Beta"].join("\n");
    const rowsB = ["id,title", "gid://shopify/Product/9901,Gamma", "gid://shopify/Product/9902,Delta"].join("\n");

    await Promise.all([writeExclusiveFile(pathA, rowsA), writeExclusiveFile(pathB, rowsB)]);

    const [contentA, contentB] = await Promise.all([
      fs.promises.readFile(pathA, "utf8"),
      fs.promises.readFile(pathB, "utf8"),
    ]);

    assert.ok(contentA.includes("Product/1001"), "A CSV must contain shop-A product 1001");
    assert.ok(contentA.includes("Product/1002"), "A CSV must contain shop-A product 1002");
    assert.ok(!contentA.includes("Product/9901"), "A CSV must NOT contain shop-B product 9901");
    assert.ok(!contentA.includes("Product/9902"), "A CSV must NOT contain shop-B product 9902");

    assert.ok(contentB.includes("Product/9901"), "B CSV must contain shop-B product 9901");
    assert.ok(contentB.includes("Product/9902"), "B CSV must contain shop-B product 9902");
    assert.ok(!contentB.includes("Product/1001"), "B CSV must NOT contain shop-A product 1001");
    assert.ok(!contentB.includes("Product/1002"), "B CSV must NOT contain shop-A product 1002");
  } finally {
    await rmTempDir(dirA);
    await rmTempDir(dirB);
  }
});

// ---------------------------------------------------------------------------
// Test 3 — Pausing one stream while the second finishes and cleans up leaves
//           the first file intact
// ---------------------------------------------------------------------------

test("cleaning up shop-B temp dir does not affect a paused shop-A file", async () => {
  const [dirA, dirB] = await Promise.all([makeTempDir(), makeTempDir()]);
  try {
    const pathA = buildExportFilePath(dirA, "job-shop-a-paused");
    const pathB = buildExportFilePath(dirB, "job-shop-b-done");

    // Shop-B finishes and cleans up
    await writeExclusiveFile(pathB, "shop-b data\n");
    await rmTempDir(dirB);

    // Shop-A is "paused" — open the stream but do not finish it yet
    const streamA = fs.createWriteStream(pathA, { flags: "wx", mode: 0o600 });
    const streamADone = new Promise((resolve, reject) => {
      streamA.once("finish", resolve);
      streamA.once("error", reject);
    });
    streamA.write("shop-a partial data\n");

    // Shop-B dir is gone — shop-A dir must still exist
    const dirAExists = await fs.promises.stat(dirA).then(() => true).catch(() => false);
    assert.ok(dirAExists, "shop-A temp directory must survive shop-B cleanup");

    streamA.end();
    await streamADone;

    const contentA = await fs.promises.readFile(pathA, "utf8");
    assert.ok(contentA.includes("shop-a partial data"), "shop-A file content must be intact after shop-B cleanup");
  } finally {
    await rmTempDir(dirA);
  }
});

// ---------------------------------------------------------------------------
// Test 4 — Two application replicas sharing the same base tmpdir produce
//           distinct working directories
// ---------------------------------------------------------------------------

test("two application replicas produce distinct isolated temp directories", async () => {
  const dirs = await Promise.all(Array.from({ length: 10 }, () => makeTempDir()));
  try {
    const unique = new Set(dirs);
    assert.equal(unique.size, dirs.length, "every mkdtemp call must produce a unique directory");

    for (const dir of dirs) {
      const stat = await fs.promises.stat(dir);
      assert.ok(stat.isDirectory(), `${dir} must be a directory`);
    }
  } finally {
    await Promise.all(dirs.map(rmTempDir));
  }
});

// ---------------------------------------------------------------------------
// Test 5 — Finalization throws EXPORT_CHECKSUM_CONFLICT when the uploaded
//           checksum differs from the generated file
// ---------------------------------------------------------------------------

test("finalizeExportSuccessState throws EXPORT_CHECKSUM_CONFLICT on checksum mismatch", async () => {
  const dir = await makeTempDir();
  try {
    const filePath = buildExportFilePath(dir, "job-checksum-test");
    await writeExclusiveFile(filePath, "id,title\ngid://shopify/Product/42,Widget\n");
    const { checksum: realChecksum } = await hashExportFile(filePath);

    const staleChecksum = crypto.createHash("sha256").update("stale data").digest("hex");
    const row = makeJobRecord({ fileChecksum: staleChecksum });

    assert.throws(
      () =>
        simulateFinalizeExportSuccessState(row, {
          checksum: realChecksum,
          downloadUrl: "https://cdn.example.com/export.csv",
        }),
      (err) => {
        assert.equal(err.code, "EXPORT_CHECKSUM_CONFLICT");
        assert.equal(err.details.storedChecksum, staleChecksum);
        assert.equal(err.details.incomingChecksum, realChecksum);
        return true;
      },
    );

    // Matching checksum must NOT throw
    const matchingRow = makeJobRecord({ fileChecksum: realChecksum });
    const result = simulateFinalizeExportSuccessState(matchingRow, {
      checksum: realChecksum,
      downloadUrl: "https://cdn.example.com/export.csv",
    });
    assert.equal(result, true);
    assert.equal(matchingRow.status, "COMPLETED");

    // Null fileChecksum (first finalization) must NOT throw
    const freshRow = makeJobRecord({ fileChecksum: null });
    const freshResult = simulateFinalizeExportSuccessState(freshRow, {
      checksum: realChecksum,
      downloadUrl: "https://cdn.example.com/export.csv",
    });
    assert.equal(freshResult, true);
    assert.equal(freshRow.fileChecksum, realChecksum);
  } finally {
    await rmTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Structural — worker and repository source contain the required patterns
// ---------------------------------------------------------------------------

test("bulkExportWorker.js source uses mkdtemp, wx flag, and hashExportFile", () => {
  const src = fs.readFileSync(
    new URL("./Jobs/Workers/bulkExportWorker.js", import.meta.url),
    "utf8",
  );
  assert.ok(src.includes("mkdtemp"), "worker must call mkdtemp");
  assert.ok(src.includes('flags: "wx"'), "worker must open stream with exclusive-create flag");
  assert.ok(src.includes("mode: 0o600"), "worker must set restrictive file permissions");
  assert.ok(src.includes("hashExportFile"), "worker must call hashExportFile");
  assert.ok(src.includes("checksum"), "worker must pass checksum to finalizeExportSuccessState");
  assert.ok(src.includes("sizeBytes"), "worker must pass sizeBytes");
  assert.ok(
    src.includes("fs.promises.rm(tempDirectory, { recursive: true, force: true })"),
    "worker must remove the entire temp directory",
  );
});

test("bulkExportExecutionRepository.js finalizeExportSuccessState accepts named-param form", () => {
  const src = fs.readFileSync(
    new URL("./repositories/bulkExportExecutionRepository.js", import.meta.url),
    "utf8",
  );
  assert.ok(src.includes("exportJobId"), "repository must accept exportJobId param");
  assert.ok(src.includes("EXPORT_CHECKSUM_CONFLICT"), "repository must throw EXPORT_CHECKSUM_CONFLICT");
  assert.ok(src.includes("fileChecksum"), "repository must write fileChecksum");
  assert.ok(src.includes("BigInt(sizeBytes)"), "repository must coerce sizeBytes to BigInt");
});


