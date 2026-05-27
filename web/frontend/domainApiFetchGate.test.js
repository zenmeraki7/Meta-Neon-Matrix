import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOMAIN_ROOT = path.join(ROOT, "web/frontend/Domain");
const BASELINE_ALLOWED_FILES = new Set([
  "web/frontend/Domain/Feedback/services/feedbackService.js",
  "web/frontend/Domain/History/components/ExportTable.tsx",
  "web/frontend/Domain/History/components/HistoryTable.jsx",
  "web/frontend/Domain/History/components/ImportHistory.jsx",
  "web/frontend/Domain/History/components/RecurringEditView.jsx",
  "web/frontend/Domain/History/components/RecurringHistory.jsx",
  "web/frontend/Domain/History/components/RecurringHistoryTable.jsx",
  "web/frontend/Domain/Spreadsheet/pages/Spreadsheet.jsx",
  "web/frontend/Domain/Subscription/services/subscriptionService.js",
  "web/frontend/Domain/products/edit/pages/EditDetails.jsx",
  "web/frontend/Domain/products/exports/components/ScheduledExportModal.jsx",
  "web/frontend/Domain/products/list/components/FilterPanel.jsx",
]);

function listFilesRecursive(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(absolutePath));
      continue;
    }
    if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function toRepoRelative(filePath) {
  return path.relative(ROOT, filePath).replaceAll("\\", "/");
}

function hasRawApiFetch(fileContent) {
  return /fetch\s*\(\s*([`'"])\s*\/api\//.test(fileContent);
}

test("Domain/** raw /api fetch usage does not grow (CI auth bypass gate)", () => {
  const domainFiles = listFilesRecursive(DOMAIN_ROOT);
  const offenders = [];

  for (const absolutePath of domainFiles) {
    const content = fs.readFileSync(absolutePath, "utf8");
    if (hasRawApiFetch(content)) {
      offenders.push(toRepoRelative(absolutePath));
    }
  }

  offenders.sort();
  const unexpected = offenders.filter((file) => !BASELINE_ALLOWED_FILES.has(file));
  assert.deepEqual(
    unexpected,
    [],
    `New raw /api fetch calls detected in Domain/**: ${unexpected.join(", ")}`,
  );
});

