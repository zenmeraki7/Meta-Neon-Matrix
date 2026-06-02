import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("bootstrapController has no direct Prisma dependency", () => {
  const source = read("web/controllers/bootstrapController.js");

  assert.equal(
    source.includes("config/database"),
    false,
    "bootstrapController must not import config/database",
  );
  assert.equal(
    /\bprisma\s*\./.test(source),
    false,
    "bootstrapController must not call prisma.* directly",
  );
  assert.ok(
    source.includes("getOperationSummary({ shop"),
    "bootstrapController must delegate operation summary to bootstrapQueryService",
  );
});
