import test from "node:test";
import assert from "node:assert/strict";

import {
  buildScheduleEditCapability,
  canUseScheduledEdits,
  SCHEDULED_EDITS_FEATURE,
  SCHEDULED_EDITS_UPGRADE_MESSAGE,
} from "./services/entitlement/scheduledEditEntitlement.js";
import { buildPublicApiErrorResponse } from "./utils/publicApiError.js";

test("free plan cannot schedule edit and receives structured upgrade response", () => {
  const freeSubscription = {
    planKey: "FREE",
    planName: "Free Plan",
    status: "FREE",
  };

  assert.equal(canUseScheduledEdits(freeSubscription), false);
  assert.deepEqual(buildScheduleEditCapability(freeSubscription), {
    canScheduleEdits: false,
    canScheduleExports: false,
    planKey: "FREE",
    planName: "Free Plan",
    isDevelopmentPlan: false,
    upgradeUrl: "/pricing",
    billingUrl: "/pricing",
  });

  const { statusCode, body } = buildPublicApiErrorResponse(
    {
      code: "UPGRADE_REQUIRED",
      message: SCHEDULED_EDITS_UPGRADE_MESSAGE,
      details: {
        feature: SCHEDULED_EDITS_FEATURE,
        upgradeRequired: true,
        billingUrl: "/pricing",
      },
    },
    "UPGRADE_REQUIRED",
  );

  assert.equal(statusCode, 403);
  assert.equal(body.success, false);
  assert.equal(body.code, "UPGRADE_REQUIRED");
  assert.equal(body.message, SCHEDULED_EDITS_UPGRADE_MESSAGE);
  assert.equal(body.feature, "scheduled_edits");
  assert.equal(body.upgradeRequired, true);
  assert.equal(body.billingUrl, "/pricing");
  assert.match(body.errorId, /^[a-f0-9]{16}$/);
});

test("active paid plan can schedule edit", () => {
  assert.equal(
    canUseScheduledEdits({
      planKey: "ADVANCED_MONTHLY",
      planName: "Advanced Monthly",
      status: "ACTIVE",
    }),
    true,
  );

  assert.equal(
    buildScheduleEditCapability({
      planKey: "PRO_MONTHLY",
      planName: "Pro Monthly",
      status: "ACTIVE",
    }).canScheduleEdits,
    true,
  );
});

test("inactive paid plan cannot schedule edit", () => {
  assert.equal(
    canUseScheduledEdits({
      planKey: "PRO_MONTHLY",
      planName: "Pro Monthly",
      status: "CANCELLED",
    }),
    false,
  );
});
