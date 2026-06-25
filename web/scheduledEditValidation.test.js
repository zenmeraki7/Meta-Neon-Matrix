import test from "node:test";
import assert from "node:assert/strict";

import { buildScheduledEditCommand } from "./normalizers/productBulkEditCommandNormalizer.js";

function buildBody(overrides = {}) {
  return {
    previewContractId: "preview-1",
    previewFilterHash: "filter-hash",
    previewMirrorBatchId: "mirror-batch",
    previewFieldRegistryVersion: "field-v1",
    previewOperatorRegistryVersion: "operator-v1",
    approvedTargetCount: 1,
    scheduledAt: "2999-01-01T00:00:00.000Z",
    scheduledUndoAt: null,
    timezone: "America/New_York",
    scheduleConfirmationText: "SCHEDULE",
    freezeMode: "STATIC_AT_SCHEDULE_CREATE",
    ...overrides,
  };
}

function buildCommand(overrides = {}) {
  return buildScheduledEditCommand({
    body: buildBody(overrides),
    headers: { idempotencyKey: "schedule-test-key" },
    context: {
      shop: "demo-zen-store.myshopify.com",
      accessToken: "token",
      scope: "scope",
      actor: { actorId: "user-1" },
      subscription: { planKey: "PRO_MONTHLY" },
      entitlement: {},
      activePlan: {},
    },
  });
}

test("scheduled edit API command accepts future UTC ISO scheduledAt", () => {
  const command = buildCommand({
    scheduledAt: "2999-01-01T00:00:00+00:00",
  });

  assert.equal(command.scheduledAt, "2999-01-01T00:00:00.000Z");
  assert.equal(command.timezone, "America/New_York");
});

test("scheduled edit API command rejects past UTC scheduledAt", () => {
  assert.throws(
    () => buildCommand({ scheduledAt: "2000-01-01T00:00:00.000Z" }),
    /Invalid scheduledAt: must be in the future/,
  );
});

test("scheduled edit API command rejects missing timezone", () => {
  assert.throws(
    () => buildCommand({ timezone: "" }),
    /timezone is required/,
  );
});

test("scheduled edit API command rejects invalid timezone", () => {
  assert.throws(
    () => buildCommand({ timezone: "America/Not_A_Zone" }),
    /Invalid timezone/,
  );
});

test("scheduled edit API command rejects non-ISO date strings", () => {
  assert.throws(
    () => buildCommand({ scheduledAt: "20-05-2027 02:03 AM" }),
    /Invalid scheduledAt: must be a UTC ISO string/,
  );
});
