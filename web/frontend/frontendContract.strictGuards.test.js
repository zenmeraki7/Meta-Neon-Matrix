import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FRONTEND_ROOT = path.join(ROOT, "web/frontend");
const SELF_FILE = "web/frontend/frontendContract.strictGuards.test.js";

const IDEMPOTENT_REQUIRED_PREFIXES = [
  "/api/products/update",
  "/api/products/schedule-task",
  "/api/products/create-recurring-edit",
  "/api/recurring-edits",
  "/api/products/create-scheduled-export",
  "/api/products/export",
  "/api/products/undo-edit",
  "/api/products/update-recurring-edit",
  "/api/products/delete-recurring-edit",
  "/api/products/csv/import",
  "/api/subscription/create-subscription",
  "/api/product-code-snippets",
];

function listFilesRecursive(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
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

function findAllMatches(content, regex) {
  const matches = [];
  for (const match of content.matchAll(regex)) {
    matches.push(match);
  }
  return matches;
}

function hasIdempotentTrueNearby(content, index, lookahead = 320) {
  const start = Math.max(0, index);
  const end = Math.min(content.length, index + lookahead);
  const window = content.slice(start, end);
  return /idempotent\s*:\s*true/.test(window);
}

function isCriticalWriteRoute(routePath) {
  return IDEMPOTENT_REQUIRED_PREFIXES.some(
    (prefix) => routePath === prefix || routePath.startsWith(`${prefix}/`),
  );
}

test("frontend strict guard: no raw fetch", () => {
  const files = listFilesRecursive(FRONTEND_ROOT);
  const offenders = [];

  for (const absolutePath of files) {
    const relativePath = toRepoRelative(absolutePath);
    if (relativePath === SELF_FILE || relativePath === "web/frontend/utils/performanceTelemetry.js") {
      continue;
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    if (/\bfetch\s*\(/.test(content)) {
      offenders.push(relativePath);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Raw fetch() is disallowed in web/frontend: ${offenders.join(", ")}`,
  );
});

test("frontend strict guard: no deprecated Polaris Banner status prop", () => {
  const files = listFilesRecursive(FRONTEND_ROOT);
  const offenders = [];

  for (const absolutePath of files) {
    const relativePath = toRepoRelative(absolutePath);
    if (relativePath === SELF_FILE) {
      continue;
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    if (/<Banner[^>]*\bstatus\s*=/.test(content)) {
      offenders.push(relativePath);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Deprecated Banner status prop found: ${offenders.join(", ")}`,
  );
});

test("frontend strict guard: no LegacyCard", () => {
  const files = listFilesRecursive(FRONTEND_ROOT);
  const offenders = [];

  for (const absolutePath of files) {
    const relativePath = toRepoRelative(absolutePath);
    if (relativePath === SELF_FILE) {
      continue;
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    if (/\bLegacyCard\b/.test(content)) {
      offenders.push(relativePath);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `LegacyCard is disallowed: ${offenders.join(", ")}`,
  );
});

test("frontend strict guard: critical write calls include idempotent protection", () => {
  const files = listFilesRecursive(FRONTEND_ROOT);
  const offenders = [];
  const callRegex =
    /\b(?:protectedApi(?:Post|Put|Patch|Delete)|api\.(?:post|put|patch))\s*\(\s*([`'"])(\/api\/[^`'"]+)\1/g;

  for (const absolutePath of files) {
    const relativePath = toRepoRelative(absolutePath);
    if (relativePath === SELF_FILE) {
      continue;
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    const matches = findAllMatches(content, callRegex);
    for (const match of matches) {
      const routePath = match[2].split("?")[0];
      if (!isCriticalWriteRoute(routePath)) {
        continue;
      }
      const callIndex = match.index ?? 0;
      if (!hasIdempotentTrueNearby(content, callIndex, 3000)) {
        offenders.push(`${relativePath} -> ${routePath}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Critical write calls must include idempotent: true nearby: ${offenders.join(", ")}`,
  );
});

test("schedule edit modal disables paid-only scheduling and handles upgrade responses", () => {
  const modalPath = path.join(
    FRONTEND_ROOT,
    "Domain/products/edit/components/ScheduleEdit.jsx",
  );
  const source = fs.readFileSync(modalPath, "utf8");

  assert.ok(source.includes('api.get("/api/subscription/get-plans")'));
  assert.ok(source.includes("canScheduleEdits"));
  assert.ok(source.includes("scheduleUpgradeRequired"));
  assert.ok(source.includes("Scheduled edits require an active paid plan."));
  assert.ok(source.includes("disabled:"));
  assert.ok(source.includes("scheduleUpgradeRequired ||"));
  assert.ok(source.includes('onAction: () => navigate(resolvedBillingUrl)'));

  const guardIndex = source.indexOf("if (!canScheduleEdits)");
  const postIndex = source.indexOf('api.post("/api/products/schedule-task"');
  assert.ok(guardIndex >= 0, "Schedule submit must guard on canScheduleEdits");
  assert.ok(postIndex >= 0, "Schedule submit must still call schedule-task for eligible shops");
  assert.ok(
    guardIndex < postIndex,
    "Schedule submit must return before schedule-task when canScheduleEdits is false",
  );

  assert.ok(source.includes('errorCode === "UPGRADE_REQUIRED"'));
  assert.ok(source.includes('console.warn("Scheduled edit upgrade required"'));
  assert.ok(source.includes("errorId:"));
});
