import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("export and recurring list services expose cursor traversal pageInfo contract", () => {
  const exportService = read("web/services/productService/productExportService.js");
  const recurringService = read("web/services/recurringEditService.js");

  const requiredTokens = [
    "hasNextPage",
    "hasPreviousPage",
    "nextCursor",
    "endCursor",
  ];

  for (const token of requiredTokens) {
    assert.ok(
      exportService.includes(token),
      `productExportService is missing ${token} cursor contract`,
    );
    assert.ok(
      recurringService.includes(token),
      `recurringEditService is missing ${token} cursor contract`,
    );
  }
});

