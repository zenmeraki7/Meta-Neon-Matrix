import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  assertScheduledExportAccess,
  hasScheduledExportAccess,
} from "./services/scheduledExportPlanService.js";
import {
  buildPlanCapabilities,
  SCHEDULED_EXPORTS_FEATURE,
} from "./services/entitlement/planCapabilities.js";
import {
  resolveBillingStateFromActiveSubscriptions,
  resolveBillingStateFromRecord,
} from "./services/subscriptionAuthorityService.js";
import { buildPublicApiErrorResponse } from "./utils/publicApiError.js";
import { zonedDateTimeToUtcIso } from "./frontend/utils/timezoneDateTime.js";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("scheduled export capability is separate from scheduled edit capability", async () => {
  assert.equal(hasScheduledExportAccess({ planKey: "FREE", status: "FREE" }), false);
  assert.equal(hasScheduledExportAccess({ planKey: "BASIC_MONTHLY", status: "ACTIVE" }), false);
  assert.equal(hasScheduledExportAccess({ planKey: "ADVANCED_MONTHLY", status: "ACTIVE" }), true);
  assert.equal(hasScheduledExportAccess({ planKey: "PRO_MONTHLY", status: "ACTIVE" }), true);
  assert.equal(hasScheduledExportAccess({ planKey: "DEV_TEST", status: "ACTIVE" }), true);

  assert.deepEqual(
    buildPlanCapabilities({ planKey: "BASIC_MONTHLY", status: "ACTIVE" }),
    {
      canScheduleEdits: true,
      canScheduleExports: false,
      planKey: "BASIC_MONTHLY",
      planName: "Free Plan",
      isDevelopmentPlan: false,
      upgradeUrl: "/pricing",
      billingUrl: "/pricing",
    },
  );
});

test("scheduled export denial returns structured scheduled_exports upgrade response", async () => {
  await assert.rejects(
    () => assertScheduledExportAccess({ planKey: "FREE", status: "FREE" }),
    (error) => {
      assert.equal(error.code, "UPGRADE_REQUIRED");
      assert.equal(error.details.feature, SCHEDULED_EXPORTS_FEATURE);
      assert.equal(error.details.upgradeRequired, true);
      return true;
    },
  );

  const { statusCode, body } = buildPublicApiErrorResponse(
    await assertScheduledExportAccess({ planKey: "FREE", status: "FREE" }).catch((error) => error),
    "UPGRADE_REQUIRED",
  );

  assert.equal(statusCode, 403);
  assert.equal(body.code, "UPGRADE_REQUIRED");
  assert.equal(body.feature, "scheduled_exports");
  assert.equal(body.upgradeRequired, true);
  assert.equal(body.billingUrl, "/pricing");
  assert.equal(body.stack, undefined);
  assert.equal(body.rootCause, undefined);
});

test("scheduled export ignores browser-supplied fake plan and capabilities", async () => {
  await assert.rejects(
    () => assertScheduledExportAccess({
      planKey: "FREE",
      status: "FREE",
      plan: "PRO_MONTHLY",
      canScheduleExports: true,
    }),
    /SCHEDULED_EXPORT_PLAN_UPGRADE_REQUIRED/,
  );
});

test("billing state fails closed for unknown, multiple, restricted, and missing states", () => {
  assert.throws(
    () => resolveBillingStateFromRecord({
      shop: "demo.myshopify.com",
      subscription: { planKey: "ALIEN_MONTHLY", planName: "Alien", status: "ACTIVE" },
    }),
    /UNKNOWN_ACTIVE_SUBSCRIPTION/,
  );

  assert.throws(
    () => resolveBillingStateFromActiveSubscriptions({
      shop: "demo.myshopify.com",
      activeSubscriptions: [
        { id: "sub-1", name: "Advanced", status: "ACTIVE" },
        { id: "sub-2", name: "Pro", status: "ACTIVE" },
      ],
    }),
    /MULTIPLE_ACTIVE_SUBSCRIPTIONS/,
  );

  assert.throws(
    () => resolveBillingStateFromActiveSubscriptions({
      shop: "demo.myshopify.com",
      activeSubscriptions: [{ id: "sub-1", name: "Advanced", status: "FROZEN" }],
    }),
    /BILLING_RESTRICTED/,
  );

  const missing = resolveBillingStateFromRecord({
    shop: "demo.myshopify.com",
    subscription: null,
  });
  assert.equal(missing.planKey, "FREE");
  assert.equal(missing.capabilities.canScheduleExports, false);
});

test("scheduled export schedule conversion and validation contract stays timezone safe", () => {
  assert.equal(
    zonedDateTimeToUtcIso("08-07-2026", "11:41 AM", "Asia/Kolkata"),
    "2026-07-08T06:11:00.000Z",
  );
  assert.throws(
    () => zonedDateTimeToUtcIso("08-07-2026", "11:41 AM", "America/Not_A_Zone"),
    /timezone is unavailable or invalid/,
  );
});

test("scheduled export endpoint and UI use canScheduleExports, not canScheduleEdits", () => {
  const planService = read("web/services/scheduledExportPlanService.js");
  const modal = read("web/frontend/Domain/products/exports/components/ScheduledExportModal.jsx");
  const dto = read("web/dtos/subscriptionPlanDto.js");

  assert.equal(planService.includes("canScheduleEdits"), false);
  assert.ok(planService.includes("canScheduleExports"));
  assert.ok(modal.includes("canScheduleExports"));
  assert.ok(dto.includes("canScheduleExports"));
});
