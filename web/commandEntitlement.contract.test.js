import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, relPath), "utf8");
}

test("product import command service enforces entitlement assertion", () => {
  const source = read("services/productImport/ProductImportCommandService.js");
  assert.match(
    source,
    /assertFeatureEntitlement\(\s*\{[\s\S]*feature:\s*"IMPORT_CSV"/,
    "ProductImportCommandService must assert IMPORT_CSV entitlement in command path",
  );
});

test("product sync command service enforces entitlement assertion", () => {
  const source = read("services/productSync/ProductSyncCommandService.js");
  assert.match(
    source,
    /assertFeatureEntitlement\(\s*\{[\s\S]*feature:\s*"PRODUCT_SYNC"/,
    "ProductSyncCommandService must assert PRODUCT_SYNC entitlement in command path",
  );
});

test("bulk execute command service enforces persistence-backed idempotency", () => {
  const source = read("services/bulkEdit/BulkEditCommandService.js");
  assert.match(
    source,
    /IDEMPOTENCY_KEY_REQUIRED/,
    "BulkEditCommandService must require idempotency key",
  );
  assert.match(
    source,
    /idempotencyStore\.begin\(/,
    "BulkEditCommandService must start idempotency stage from persistent store",
  );
  assert.match(
    source,
    /idempotencyStore\.complete\(/,
    "BulkEditCommandService must persist completed idempotent response",
  );
});

test("import command service enforces persistence-backed idempotency", () => {
  const source = read("services/productImport/ProductImportCommandService.js");
  assert.match(
    source,
    /IDEMPOTENCY_KEY_REQUIRED/,
    "ProductImportCommandService must require idempotency key",
  );
  assert.match(
    source,
    /idempotencyStore\.begin\(/,
    "ProductImportCommandService must start idempotency stage from persistent store",
  );
  assert.match(
    source,
    /idempotencyStore\.complete\(/,
    "ProductImportCommandService must persist completed idempotent response",
  );
});
