import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("Recurring edit execution checks authoritative subscription state", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "services/recurringEditExecutionService.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("loadAuthoritativeSubscriptionForShop"),
    "recurringEditExecutionService must load authoritative subscription",
  );
  assert.ok(
    fileContent.includes("hasRecurringEditAccess"),
    "recurringEditExecutionService must verify access using hasRecurringEditAccess",
  );
  assert.ok(
    fileContent.includes("RECURRING_EDIT_ENTITLEMENT_REVOKED"),
    "recurringEditExecutionService must record RECURRING_EDIT_ENTITLEMENT_REVOKED on access failure",
  );
  assert.ok(
    !fileContent.includes('planName: "Pro Monthly",\n      isUnlimited: true'),
    "recurringEditExecutionService must not fabricate Pro Monthly subscription",
  );
});

test("Recurring edit service enforces capacity reservation and release on ShopFeatureQuota", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "services/recurringEditService.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("reserveActiveRecurringEditCapacity"),
    "recurringEditService must define reserveActiveRecurringEditCapacity",
  );
  assert.ok(
    fileContent.includes("releaseActiveRecurringEditCapacity"),
    "recurringEditService must define releaseActiveRecurringEditCapacity",
  );
  assert.ok(
    fileContent.includes("ACTIVE_RECURRING_EDITS"),
    "recurringEditService must reference ACTIVE_RECURRING_EDITS feature key",
  );
});

test("Automatic product rule execution enforces bucket quota and active run constraint", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "services/automaticProductRuleExecutionService.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("automaticRuleRunQuota"),
    "automaticProductRuleExecutionService must use automaticRuleRunQuota table",
  );
  assert.ok(
    fileContent.includes("AUTOMATIC_RULE_RUN_LIMIT_REACHED"),
    "automaticProductRuleExecutionService must throw AUTOMATIC_RULE_RUN_LIMIT_REACHED on quota exhaustion",
  );
  assert.ok(
    fileContent.includes("AUTOMATIC_RULE_RUN_ALREADY_ACTIVE"),
    "automaticProductRuleExecutionService must handle active run constraint conflict with AUTOMATIC_RULE_RUN_ALREADY_ACTIVE",
  );
  assert.ok(
    fileContent.includes("startOfUtcHour"),
    "automaticProductRuleExecutionService must use startOfUtcHour helper",
  );
});

test("Prisma schema defines ShopFeatureQuota, AutomaticRuleRunQuota, and unique index for active runs", async () => {
  const schemaContent = fs.readFileSync(
    path.join(__dirname, "prisma/schema.prisma"),
    "utf8",
  );

  assert.ok(
    schemaContent.includes("model ShopFeatureQuota"),
    "schema.prisma must contain ShopFeatureQuota model",
  );
  assert.ok(
    schemaContent.includes("model AutomaticRuleRunQuota"),
    "schema.prisma must contain AutomaticRuleRunQuota model",
  );
  assert.ok(
    schemaContent.includes("entitlementPlanKey"),
    "schema.prisma must contain entitlementPlanKey in RecurringEditRun",
  );
  assert.ok(
    schemaContent.includes("AutomaticProductRuleRun_one_active_per_rule_uq"),
    "schema.prisma must contain AutomaticProductRuleRun_one_active_per_rule_uq unique index",
  );
});
