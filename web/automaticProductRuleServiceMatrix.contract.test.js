import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(relPath) {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

const mutateSource = read("web/services/automaticProductRule/commands/mutateAutomaticProductRuleCommand.js");
const runNowSource = read("web/services/automaticProductRule/commands/runAutomaticProductRuleNowCommand.js");
const guardSource = read("web/services/automaticProductRule/automaticProductRuleGuards.js");
const persistenceSource = read("web/services/automaticProductRule/automaticProductRulePersistence.js");
const dtoMapperSource = read("web/controllers/automaticProductRuleDtoMapper.js");

test("create rejects missing entitlement and enforces quota + audit", () => {
  assert.match(mutateSource, /assertEntitlementAllowed\(entitlement\)/);
  assert.match(mutateSource, /assertAutomaticRuleQuota\(\{/);
  assert.match(mutateSource, /action:\s*"AUTOMATIC_RULE_CREATED"/);
});

test("update rejects stale revision, blocks config mutation with active run, increments revision", () => {
  assert.match(mutateSource, /RULE_REVISION_CONFLICT/);
  assert.match(mutateSource, /assertNoActiveRunForConfigMutation\(\{/);
  assert.match(mutateSource, /revision:\s*\{\s*increment:\s*1/s);
});

test("pause disables scheduler and cancel_queued cancels queued runs", () => {
  assert.match(mutateSource, /schedulerDisabledAt:\s*now/);
  assert.match(mutateSource, /pausePolicy === PAUSE_POLICY\.CANCEL_QUEUED/);
  assert.match(mutateSource, /status:\s*\{\s*in:\s*\[RUN_STATUS\.TARGET_FREEZE_QUEUED\]/s);
});

test("resume rechecks entitlement/quota/mirror safety", () => {
  assert.match(mutateSource, /assertEntitlementAllowed\(entitlement\)/);
  assert.match(mutateSource, /assertResumeQuota\(\{/);
  assert.match(mutateSource, /assertMirrorSafeForTargeting\(\{/);
});

test("runNow requires idempotency + expected revision + mirror safety + active-run conflict gate", () => {
  assert.match(runNowSource, /assertIdempotencyKey\(idempotencyKey\)/);
  assert.match(runNowSource, /assertExpectedRuleRevision\(expectedRuleRevision\)/);
  assert.match(runNowSource, /assertRuleRevision\(rule,\s*safeExpectedRuleRevision\)/);
  assert.match(runNowSource, /assertMirrorSafeForTargeting\(\{/);
  assert.match(runNowSource, /assertNoActiveRun\(\{/);
});

test("runNow idempotency returns same run and persists operation/run/freeze/outbox/audit", () => {
  assert.match(runNowSource, /shop_idempotencyKey/);
  assert.match(runNowSource, /return existingRun/);
  assert.match(runNowSource, /tx\.operation\.create/);
  assert.match(runNowSource, /tx\.automaticProductRuleRun\.create/);
  assert.match(runNowSource, /tx\.targetFreezeCommand\.create/);
  assert.match(runNowSource, /tx\.outboxEvent\.create/);
  assert.match(runNowSource, /action:\s*"AUTOMATIC_RULE_RUN_NOW_REQUESTED"/);
});

test("delete is soft-delete only, disables scheduler, and cancel_queued cancels queued runs", () => {
  assert.match(mutateSource, /status:\s*RULE_STATUS\.DELETED/);
  assert.match(mutateSource, /deletedAt:\s*now/);
  assert.match(mutateSource, /schedulerDisabledAt:\s*now/);
  assert.match(mutateSource, /deletePolicy === DELETE_POLICY\.CANCEL_QUEUED/);
});

test("status mapping exposes public lifecycle states only", () => {
  assert.match(dtoMapperSource, /toPublicAutomaticRuleRunStatus/);
  assert.match(dtoMapperSource, /TARGET_FREEZE_QUEUED:\s*"preparing"/);
  assert.match(dtoMapperSource, /SUCCEEDED:\s*"completed"/);
  assert.match(dtoMapperSource, /UNDO_EXECUTING:\s*"undo_running"/);
});

test("scheduler and revision persistence fields are maintained in rule persistence layer", () => {
  assert.match(persistenceSource, /revision:\s*1/);
  assert.match(persistenceSource, /schedulerDisabledAt:\s*status === RULE_STATUS\.ACTIVE \? null : now/);
  assert.match(persistenceSource, /revision:\s*\{\s*increment:\s*1/s);
});

test("guard layer enforces active-run conflict and mirror-safety checks", () => {
  assert.match(guardSource, /assertNoActiveRun\(/);
  assert.match(guardSource, /assertNoActiveRunForConfigMutation\(/);
  assert.match(guardSource, /assertMirrorSafeForTargeting\(/);
});
