import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("no active call sites remain for legacy handleProductEditOperation finalizer", () => {
  const root = path.resolve("web");
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith(".js")) files.push(full);
    }
  }
  walk(root);

  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const isDefinitionFile = file.endsWith(
      path.join("helpers", "webhookHelpers", "bulkOperations", "bulkEdit.js"),
    );
    const isThisTest = file.endsWith(
      path.join("web", "legacyFinalizerRetirement.contract.test.js"),
    );
    if (isThisTest) continue;
    if (isDefinitionFile) continue;
    if (source.includes("handleProductEditOperation(")) offenders.push(file);
  }

  assert.deepEqual(
    offenders,
    [],
    `Legacy finalizer call sites still exist:\n${offenders.join("\n")}`,
  );
});
