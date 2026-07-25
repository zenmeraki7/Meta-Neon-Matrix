import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function walk(dir) {
  const abs = path.resolve(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const stack = [abs];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

test("repository modules are not placed under web/services/**", () => {
  const files = walk("web/services")
    .map((f) => path.relative(ROOT, f).replaceAll("\\", "/"))
    .filter((f) => /Repository\.(js|mjs|cjs|ts|tsx)$/.test(f));

  assert.equal(
    files.length,
    0,
    `Repository files must live under web/repositories, found:\n${files.join("\n")}`,
  );
});

test("no imports reference legacy service-layer repository paths", () => {
  const files = walk("web")
    .filter((f) => /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(f));

  const legacyPatterns = [
    "services/productService/productQueryRepository.js",
    "services/productService/productSyncRepository.js",
  ];

  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).replaceAll("\\", "/");
    if (rel === "web/repositoryLocationBoundary.contract.test.js") continue;
    const src = fs.readFileSync(file, "utf8");
    for (const pattern of legacyPatterns) {
      if (src.includes(pattern)) {
        offenders.push(`${rel} -> ${pattern}`);
      }
    }
  }

  assert.equal(
    offenders.length,
    0,
    `Legacy repository imports detected:\n${offenders.join("\n")}`,
  );
});
