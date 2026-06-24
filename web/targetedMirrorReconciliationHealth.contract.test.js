import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const healthSource = fs.readFileSync("web/services/mirrorHealthService.js", "utf8");
const reconciliationSource = fs.readFileSync(
  "web/services/mirrorReconciliationService.js",
  "utf8",
);

test("targeted reconciliation keeps the activated mirror readable while blocking writes", () => {
  assert.match(healthSource, /markTargetedReconciliationPending/);
  assert.match(healthSource, /mirrorHealthState:\s*"DEGRADED"/);
  assert.match(healthSource, /repairRequired:\s*false/);
  assert.match(reconciliationSource, /await markTargetedReconciliationPending\(\{/);
});

test("oversized reconciliation still requires an unsafe full repair", () => {
  const oversizedBranch = reconciliationSource.slice(
    reconciliationSource.indexOf("if (productIds.length > TARGETED_RECONCILIATION_LIMIT)"),
    reconciliationSource.indexOf("await db.$transaction"),
  );
  assert.match(oversizedBranch, /await markRepairRequired\(\{/);
  assert.match(oversizedBranch, /post_mutation_full_resync_required/);
});
