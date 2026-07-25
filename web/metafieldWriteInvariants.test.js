import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("web");
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".prisma", ".sql"]);

function walkFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "frontend") {
        continue;
      }
      walkFiles(absPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (JS_EXTENSIONS.has(ext)) {
      out.push(absPath);
    }
  }
  return out;
}

function loadCorpus() {
  const files = walkFiles(ROOT);
  return files.map((file) => ({
    file,
    source: fs.readFileSync(file, "utf8"),
  }));
}

function findMatches(corpus, matcher) {
  return corpus.filter(({ source }) => matcher(source));
}

function toRelativePaths(rows) {
  return rows.map((row) => path.relative(process.cwd(), row.file));
}

test("invariant: metafield writes must include compareDigest (optimistic concurrency)", () => {
  const corpus = loadCorpus();
  const metafieldWriteSites = findMatches(
    corpus,
    (source) => source.includes("metafieldsSet") || source.includes("METAFIELD_SET"),
  );
  assert.ok(
    metafieldWriteSites.length > 0,
    "No metafield write sites found (expected metafieldsSet/METAFIELD_SET references).",
  );

  const compareDigestSites = findMatches(
    metafieldWriteSites,
    (source) => source.includes("compareDigest"),
  );
  assert.ok(
    compareDigestSites.length > 0,
    [
      "Missing compareDigest in metafield write path.",
      "Every metafield write must send compareDigest to prevent blind overwrite on stale objects.",
      `Matched write sites: ${toRelativePaths(metafieldWriteSites).join(", ")}`,
    ].join(" "),
  );
});

test("invariant: mirror upsert must not overwrite PENDING/WRITING/ERROR with SYNCED", () => {
  const corpus = loadCorpus();
  const candidates = findMatches(
    corpus,
    (source) =>
      source.includes("upsertMetafields")
      || source.includes("metafield")
      || source.includes("Metafield"),
  );
  assert.ok(candidates.length > 0, "No metafield-related files found.");

  const guardedSites = findMatches(
    candidates,
    (source) =>
      /edit_status/i.test(source)
      && /SYNCED/i.test(source)
      && /WRITTEN/i.test(source)
      && (/PENDING/i.test(source) || /WRITING/i.test(source) || /ERROR/i.test(source)),
  );

  assert.ok(
    guardedSites.length > 0,
    [
      "Missing edit_status guard that prevents sync jobs from clobbering staged/failed writes.",
      "Expected update condition equivalent to: AND edit_status IN ('SYNCED','WRITTEN').",
    ].join(" "),
  );
});

test("invariant: writeMetafields must return structured successes/failures and not throw batch-wide", () => {
  const corpus = loadCorpus();
  const writers = findMatches(
    corpus,
    (source) =>
      /writeMetafields\s*\(/.test(source)
      || /function\s+writeMetafields/.test(source)
      || /const\s+writeMetafields\s*=/.test(source),
  );

  assert.ok(
    writers.length > 0,
    "writeMetafields implementation not found. Add function and enforce structured return contract.",
  );

  const structuredReturn = findMatches(
    writers,
    (source) =>
      /\bsuccesses\b/.test(source)
      && /\bfailures\b/.test(source)
      && /return\s*\{[\s\S]*successes[\s\S]*failures[\s\S]*\}/.test(source),
  );
  assert.ok(
    structuredReturn.length > 0,
    "writeMetafields must return { successes, failures } for per-cell outcome handling.",
  );
});

test("invariant: STALE_OBJECT must be terminal (no automatic retry loop)", () => {
  const corpus = loadCorpus();
  const staleSites = findMatches(
    corpus,
    (source) => source.includes("STALE_OBJECT"),
  );
  assert.ok(
    staleSites.length > 0,
    "Expected explicit STALE_OBJECT handling in metafield write pipeline.",
  );

  const retryingStale = findMatches(
    staleSites,
    (source) => /STALE_OBJECT[\s\S]{0,400}(retry|backoff|attempt)/i.test(source),
  );
  assert.equal(
    retryingStale.length,
    0,
    `STALE_OBJECT must not be retried. Found retry-like logic near STALE_OBJECT in: ${toRelativePaths(retryingStale).join(", ")}`,
  );
});

test("invariant: owner id for metafield writes must preserve full Shopify GID", () => {
  const corpus = loadCorpus();
  const ownerRefs = findMatches(
    corpus,
    (source) => /ownerId|shopify_owner_id/i.test(source),
  );
  assert.ok(ownerRefs.length > 0, "No owner id references found.");

  const gidAwareSites = findMatches(
    ownerRefs,
    (source) =>
      source.includes("gid://shopify/")
      || /metafieldsSet[\s\S]{0,600}ownerId/i.test(source),
  );

  assert.ok(
    gidAwareSites.length > 0,
    "Metafield owner identity must preserve full gid://shopify/... string (not numeric-only IDs).",
  );
});
