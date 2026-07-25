import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repositorySource = readFileSync(
  new URL("./repositories/automaticProductRuleRunRepository.js", import.meta.url),
  "utf8",
);

test("automatic rule run repository only writes current Prisma lifecycle enum values", () => {
  assert.match(repositorySource, /RUN_STATUS\.TARGET_FREEZE_QUEUED/);
  assert.match(repositorySource, /RUN_STATUS\.EXECUTING/);
  assert.match(repositorySource, /RUN_STATUS\.SUCCEEDED/);
  assert.match(repositorySource, /RUN_STATUS\.CANCELLED/);

  for (const retiredStatus of ["PENDING", "PROCESSING", "SUCCESS", "SKIPPED"]) {
    assert.doesNotMatch(
      repositorySource,
      new RegExp(`status:\\s*["']${retiredStatus}["']`),
      `repository must not send retired ${retiredStatus} value to Prisma`,
    );
  }
});
