import test from "node:test";
import assert from "node:assert/strict";
import { toAutomaticRuleRunListDto } from "./controllers/automaticProductRuleDtoMapper.js";

test("maps internal automatic rule run statuses to public lifecycle statuses", () => {
  const runs = [
    { id: "1", automaticProductRuleId: "r1", status: "TARGET_FREEZE_QUEUED" },
    { id: "2", automaticProductRuleId: "r1", status: "TARGET_FREEZING" },
    { id: "3", automaticProductRuleId: "r1", status: "TARGET_FROZEN" },
    { id: "4", automaticProductRuleId: "r1", status: "EXECUTING" },
    { id: "5", automaticProductRuleId: "r1", status: "VERIFYING" },
    { id: "6", automaticProductRuleId: "r1", status: "SUCCEEDED" },
    { id: "7", automaticProductRuleId: "r1", status: "FAILED" },
    { id: "8", automaticProductRuleId: "r1", status: "CANCELLED" },
    { id: "9", automaticProductRuleId: "r1", status: "UNDO_PENDING" },
    { id: "10", automaticProductRuleId: "r1", status: "UNDO_EXECUTING" },
  ];

  const mapped = toAutomaticRuleRunListDto(runs);

  assert.equal(mapped[0].status, "preparing");
  assert.equal(mapped[1].status, "preparing");
  assert.equal(mapped[2].status, "ready");
  assert.equal(mapped[3].status, "running");
  assert.equal(mapped[4].status, "verifying");
  assert.equal(mapped[5].status, "completed");
  assert.equal(mapped[6].status, "failed");
  assert.equal(mapped[7].status, "cancelled");
  assert.equal(mapped[8].status, "undo_pending");
  assert.equal(mapped[9].status, "undo_running");
});
