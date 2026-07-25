import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("execution preparation uses deterministic one-row-per-target rule fold", () => {
  const filePath = path.join(
    __dirname,
    "services",
    "bulkEdit",
    "BulkEditExecutionPreparationService.js",
  );
  const source = fs.readFileSync(filePath, "utf8");

  assert.equal(
    source.includes("function buildProductMutationInputFromRules("),
    true,
    "buildProductMutationInputFromRules must exist",
  );
  assert.equal(
    source.includes("formattedRows.push(...mutationRows);"),
    false,
    "legacy multi-row spread push must not remain",
  );
  assert.equal(
    source.includes("if (mutationRow) {"),
    true,
    "per-target single mutation row push path must exist",
  );
});
