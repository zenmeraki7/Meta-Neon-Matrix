import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");
const source = read("web/services/bulkEdit/BulkEditVerificationService.js");
const schema = read("web/prisma/schema.prisma");

test("verification is always full and uses a fixed 500-row cursor page", () => {
  assert.ok(source.includes('const VERIFY_MODE = "FULL"'));
  assert.ok(source.includes("const VERIFY_PAGE_SIZE = 500"));
  assert.equal(source.includes("SAMPLE_PLUS_FAILURES"), false);
  assert.equal(source.includes("resolveSampleLimit"), false);
  assert.ok(source.includes("skip: verificationCursor"));
  assert.ok(source.includes("take: VERIFY_PAGE_SIZE"));
});

test("verification cursor pages over a stable applied-record set", () => {
  assert.ok(source.includes('status: { in: ["SUCCESS", "VERIFIED", "VERIFICATION_FAILED"] }'));
  assert.ok(source.includes('String(row.status || "").toUpperCase() === "SUCCESS"'));
  assert.equal(source.includes('status: "FAILED"'), false);
});

test("verification page atomically persists outcomes, counters, and cursor", () => {
  assert.ok(source.includes("await db.$transaction(async (tx) =>"));
  assert.ok(source.includes('status: "VERIFIED"'));
  assert.ok(source.includes('status" = \'VERIFICATION_FAILED\''));
  assert.ok(source.includes("verificationCursor: nextCursor"));
  assert.ok(source.includes("verifiedItems: { increment: verified }"));
  assert.ok(source.includes("failedVerifications: { increment: failed }"));
  assert.ok(source.includes("VERIFICATION_CURSOR_ADVANCE_CONFLICT"));
});

test("completion requires verified plus failed verification count to equal applied count", () => {
  assert.ok(source.includes("verifiedItems + failedVerifications === Number(appliedItems || 0)"));
  assert.ok(source.includes("nextPageEnqueued: !fullCoverageAchieved"));
  assert.ok(source.includes("bulk_edit_verification_next_page"));
});

test("EditHistory persists full verification progress", () => {
  assert.match(schema, /verificationCursor\s+Int\s+@default\(0\)/);
  assert.match(schema, /verifiedItems\s+Int\s+@default\(0\)/);
  assert.match(schema, /failedVerifications\s+Int\s+@default\(0\)/);
});

test("verification comparison preserves null and typed value semantics", () => {
  assert.ok(source.includes("function valuesEquivalent"));
  assert.ok(source.includes("return current === wanted"));
  assert.equal(source.includes("String(current) !== String(wanted)"), false);
});

test("verification has a terminal timeout guard", () => {
  assert.ok(source.includes("VERIFICATION_TIMEOUT_MINUTES"));
  assert.ok(source.includes("startedAt: true"));
  assert.ok(source.includes("OPERATION_LIFECYCLE_STATES.VERIFICATION_TIMEOUT"));
  assert.ok(source.includes("Date.now() - new Date(history.startedAt).getTime() > VERIFICATION_TIMEOUT_MS"));
});
