import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TARGET_DIRS = [
  "web/controllers",
  "web/routes",
  "web/services",
  "web/Jobs/Workers",
];

const FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

const FORBIDDEN_PATTERNS = [
  /from\s+["'].*config\/database(?:\.js)?["']/g,
  /import\s*\(\s*["'].*config\/database(?:\.js)?["']\s*\)/g,
  /\bprisma\s*\./g,
  /\$queryRaw\b/g,
  /\$executeRaw\b/g,
  /\$transaction\b/g,
];

function listSourceFiles(dir) {
  const absolute = path.resolve(ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  const out = [];
  const stack = [absolute];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!FILE_EXTENSIONS.has(ext)) continue;
      out.push(full);
    }
  }

  return out;
}

function findViolations(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const rel = path.relative(ROOT, filePath).replaceAll("\\", "/");
  const violations = [];

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(src)) {
      violations.push({ rel, pattern: pattern.toString() });
    }
  }

  return violations;
}

test("hard layer boundary: Prisma access must stay out of controllers/routes/services/workers", () => {
  const files = TARGET_DIRS.flatMap((dir) => listSourceFiles(dir));
  const violations = files.flatMap((file) => findViolations(file));

  assert.equal(
    violations.length,
    0,
    `Forbidden Prisma/database usage outside repositories:\n${violations
      .map((v) => `- ${v.rel} matched ${v.pattern}`)
      .join("\n")}`,
  );
});
