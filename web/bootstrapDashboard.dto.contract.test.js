import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("dashboard bootstrap response DTO shape is stable", () => {
  const source = read("web/controllers/bootstrapController.js");

  assert.ok(source.includes("ok: true"));
  assert.ok(source.includes("shop,"));
  assert.ok(source.includes("generatedAt:"));
  assert.ok(source.includes("storeDetails:"));
  assert.ok(source.includes("syncStatus:"));
  assert.ok(source.includes("operationSummary:"));
  assert.ok(source.includes("planSnapshot:"));
  assert.ok(source.includes("currentPlanKey"));
  assert.ok(source.includes("plans:"));
});
