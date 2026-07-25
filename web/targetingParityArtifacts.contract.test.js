import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(p) {
  return fs.readFileSync(path.resolve(p), "utf8");
}

test("resolveAndMaybeFreeze returns deterministic parity artifact fields", () => {
  const src = read("web/services/targeting/TargetingEngineService.js");
  assert.ok(src.includes("parity: {"));
  assert.ok(src.includes("sampleChecksum"));
  assert.ok(src.includes("freezeChecksum"));
  assert.ok(src.includes("productTargetChecksum"));
  assert.ok(src.includes("variantTargetChecksum"));
  assert.ok(src.includes("targetResourceTypeDistribution"));
  assert.ok(src.includes("mirrorBatchId: resolved.mirrorBatchId"));
  assert.ok(src.includes("normalizedFilterHash"));
});

test("freeze path enforces target type distribution consistency", () => {
  const src = read("web/services/targeting/TargetingEngineService.js");
  assert.ok(src.includes("TARGET_TYPE_DISTRIBUTION_MISMATCH"));
  assert.ok(src.includes("computeTargetTypeDistribution"));
  assert.ok(src.includes("distributionTotal"));
});

test("risky freeze path has runtime parity gate and hard mismatch rejection", () => {
  const src = read("web/services/targeting/TargetingEngineService.js");
  assert.ok(src.includes("shouldRunTargetingParity"));
  assert.ok(src.includes("computeOrderedTargetIdentityDigestFromSql"));
  assert.ok(src.includes("TARGETING_PARITY_MISMATCH"));
  assert.ok(src.includes("buildTargetingParityError"));
});
