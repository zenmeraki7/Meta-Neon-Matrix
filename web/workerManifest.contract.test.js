import fs from "fs";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const workersDir = path.join(root, "web", "Jobs", "Workers");
const workerEntrypoint = path.join(root, "web", "worker.js");

function listWorkerFiles() {
  return fs
    .readdirSync(workersDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function parseImportedWorkerFiles(source) {
  const regex = /["']\.\/Jobs\/Workers\/([^"']+\.js)["']/g;
  const found = new Set();
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = regex.exec(source)) !== null) {
    found.add(match[1]);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

test("worker manifest: every worker file is imported by web/worker.js exactly once", () => {
  const workerFiles = listWorkerFiles();
  const source = fs.readFileSync(workerEntrypoint, "utf8");
  const importedFiles = parseImportedWorkerFiles(source);

  const missing = workerFiles.filter((file) => !importedFiles.includes(file));
  const unknown = importedFiles.filter((file) => !workerFiles.includes(file));

  assert.deepEqual(
    missing,
    [],
    `Missing worker imports in web/worker.js: ${missing.join(", ")}`,
  );
  assert.deepEqual(
    unknown,
    [],
    `Unknown worker imports in web/worker.js: ${unknown.join(", ")}`,
  );
});

