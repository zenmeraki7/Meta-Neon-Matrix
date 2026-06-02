import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "web");

// Keep this list intentionally small; any addition should be reviewed.
const UPDATE_WHITELIST = new Set([
  // Example:
  // path.resolve(ROOT, "services/someControlledCleanup.js"),
]);

function walkFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated" || entry.name === "dist") {
        continue;
      }
      walkFiles(fullPath, out);
      continue;
    }
    if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
    out.push(fullPath);
  }
  return out;
}

test("TargetSnapshot is immutable (no update/updateMany usage)", () => {
  const files = walkFiles(ROOT);
  const offenders = [];
  const forbidden = /targetSnapshot\.(update|updateMany)\s*\(/g;

  for (const filePath of files) {
    if (UPDATE_WHITELIST.has(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    if (forbidden.test(content)) {
      offenders.push(path.relative(ROOT, filePath));
    }
    forbidden.lastIndex = 0;
  }

  assert.deepEqual(
    offenders,
    [],
    `TargetSnapshot immutability violated in: ${offenders.join(", ")}`,
  );
});
