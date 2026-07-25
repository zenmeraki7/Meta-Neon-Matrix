import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

test("products route exposes filter-registry endpoint", () => {
  const routes = read("web/routes/productRoutes.js");
  assert.equal(
    routes.includes('router.get("/filter-registry", getFilterRegistry);'),
    true,
    "Missing /api/products/filter-registry route",
  );
});

test("bulk execute requires preview registry versions and enforces mismatch block", () => {
  const controller = read("web/controllers/productBulkEditController.js");
  assert.equal(
    controller.includes("PREVIEW_REGISTRY_VERSION_REQUIRED"),
    true,
    "Missing preview registry version required guard",
  );
  assert.equal(
    controller.includes("PREVIEW_REGISTRY_VERSION_MISMATCH"),
    true,
    "Missing preview registry mismatch guard",
  );
});

