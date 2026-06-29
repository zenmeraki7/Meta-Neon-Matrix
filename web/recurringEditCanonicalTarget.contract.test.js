import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCreateRecurringEditCommand } from "./normalizers/recurringEditCommandNormalizer.js";
import { RecurringEditPlanError } from "./services/recurringEditPlanService.js";
import { buildPublicApiErrorResponse } from "./utils/publicApiError.js";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("recurring edits use canonical filterAst instead of legacy filterParams", () => {
  const modal = read(
    "web/frontend/Domain/products/edit/components/RecurringEditModal.jsx",
  );
  const service = read("web/services/recurringEditService.js");

  assert.ok(
    modal.includes("filterParams: []"),
    "RecurringEditModal must not send legacy filters as recurring source of truth",
  );
  assert.ok(
    modal.includes("filterAst,"),
    "RecurringEditModal must send canonical filterAst",
  );
  assert.ok(
    modal.includes("filterVersion: filterAst.version"),
    "RecurringEditModal must send filter AST version metadata",
  );
  assert.ok(
    modal.includes("targetingFingerprint"),
    "RecurringEditModal must send targeting fingerprint metadata",
  );
  assert.ok(
    service.includes("assertCanonicalRecurringFilterSource"),
    "recurringEditService must reject legacy recurring filter sources",
  );
  assert.ok(
    service.includes("legacyFilterParams: []"),
    "recurringEditService must not pass legacy filter params into recurring targeting",
  );
});

test("recurring edit idempotency key is bound to the submitted payload", () => {
  const modal = read(
    "web/frontend/Domain/products/edit/components/RecurringEditModal.jsx",
  );

  assert.ok(
    modal.includes("payload = buildSubmitPayload();"),
    "RecurringEditModal must build the exact payload before creating the idempotency key",
  );
  assert.ok(
    modal.includes("createRecurringEditIdempotencyKey") &&
      modal.includes("stableHash(payload)"),
    "RecurringEditModal must hash the exact payload for idempotency",
  );
  assert.ok(
    modal.includes("idempotencyKey: createRecurringEditIdempotencyKey"),
    "RecurringEditModal idempotency key must include the payload hash",
  );
});

test("recurring edit schedule validation rejects unsafe schedule payloads", () => {
  const modal = read(
    "web/frontend/Domain/products/edit/components/RecurringEditModal.jsx",
  );

  assert.ok(
    modal.includes("const ALLOWED_FREQUENCIES = new Set"),
    "RecurringEditModal must validate frequency against an explicit allowlist",
  );
  assert.ok(
    modal.includes("function safeZonedDateTimeToUtcIso"),
    "RecurringEditModal must wrap timezone conversion failures",
  );
  assert.ok(
    modal.includes("isValidTimezone(resolvedTimezone)"),
    "RecurringEditModal must validate the resolved timezone before submit",
  );
  assert.ok(
    modal.includes("function validateDayOfMonth") &&
      modal.includes("day >= 1") &&
      modal.includes("day <= 31"),
    "RecurringEditModal must validate monthly day range",
  );
  assert.ok(
    modal.includes("recurringEditErrors.startInPast") &&
      modal.includes("recurringEditErrors.endInPast"),
    "RecurringEditModal must reject start/end dates in the past",
  );
});

test("recurring edit modal avoids form state atom sprawl and close-reset churn", () => {
  const modal = read(
    "web/frontend/Domain/products/edit/components/RecurringEditModal.jsx",
  );
  const page = read("web/frontend/Domain/products/edit/pages/EditPreviewPage.jsx");

  assert.ok(
    modal.includes("useReducer") &&
      modal.includes("recurringEditFormReducer"),
    "RecurringEditModal form fields must be managed through a reducer",
  );
  assert.ok(
    !modal.includes("if (!show) {\n      resetForm();"),
    "RecurringEditModal must not reset the full form in a close effect",
  );
  assert.ok(
    page.includes("{modalState.recurringEdit && ("),
    "RecurringEditModal must remain conditionally mounted by the parent",
  );
  assert.ok(
    page.includes("handleHideRecurringModal"),
    "RecurringEditModal parent must pass a stable close handler",
  );
});

test("recurring edit modal uses embedded navigation and backend enums", () => {
  const modal = read(
    "web/frontend/Domain/products/edit/components/RecurringEditModal.jsx",
  );
  const navigateHook = read("web/frontend/hooks/useEmbeddedNavigate.js");
  const normalizer = read("web/normalizers/recurringEditCommandNormalizer.js");

  assert.ok(
    modal.includes("useEmbeddedNavigate"),
    "RecurringEditModal must use the centralized embedded navigation adapter",
  );
  assert.ok(
    navigateHook.includes("useNavigate") && navigateHook.includes("redirectRemote"),
    "useEmbeddedNavigate must centralize internal and remote navigation",
  );
  assert.ok(
    modal.includes('const ACTIVE_STATUS = "ACTIVE"'),
    "RecurringEditModal must send backend status enum values",
  );
  assert.ok(
    modal.includes("FREQUENCY = Object.freeze") &&
      modal.includes("getSchedulePayloadForFrequency"),
    "RecurringEditModal must separate UI labels from stable frequency values",
  );
  assert.ok(
    normalizer.includes('"EVERY_X_MINUTES"') &&
      normalizer.includes("intervalMinutes"),
    "Recurring edit normalizer must accept interval-based backend schedules",
  );
});

test("recurring edit modal makes dynamic target count explicit and stores safety metadata", () => {
  const modal = read(
    "web/frontend/Domain/products/edit/components/RecurringEditModal.jsx",
  );
  const normalizer = read("web/normalizers/recurringEditCommandNormalizer.js");
  const service = read("web/services/recurringEditService.js");

  assert.ok(
    modal.includes("recurringEditCurrentMatchPrefix") &&
      modal.includes("Future runs will apply to products matching these filters at run time."),
    "RecurringEditModal copy must clarify that future runs use dynamic filter matches",
  );
  assert.ok(
    modal.includes("approvedPreviewCount") &&
      modal.includes("filterFingerprint") &&
      modal.includes("createdAt"),
    "RecurringEditModal payload must include approved count and targeting metadata",
  );
  assert.ok(
    normalizer.includes("approvedPreviewCount") &&
      normalizer.includes("filterFingerprint") &&
      normalizer.includes("targetingFingerprint"),
    "Recurring edit normalizer must preserve recurring target safety metadata",
  );
  assert.ok(
    service.includes("approvedPreviewCount") &&
      service.includes("frontendTargetingFingerprint"),
    "Recurring edit service must store recurring target safety metadata",
  );
});

test("recurring edit submit builds payload safely before mutation", () => {
  const modal = read(
    "web/frontend/Domain/products/edit/components/RecurringEditModal.jsx",
  );

  assert.ok(
    modal.includes("function createRecurringEditIdempotencyKey"),
    "RecurringEditModal must centralize recurring edit idempotency key creation",
  );
  assert.ok(
    modal.includes("let payload;") &&
      modal.includes("payload = buildSubmitPayload();") &&
      modal.includes("recurringEditErrors.invalidSchedule"),
    "RecurringEditModal submit must catch payload build failures before mutation",
  );
});

test("recurring edit paid-plan gate returns structured upgrade response", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const { statusCode, body } = buildPublicApiErrorResponse(
      new RecurringEditPlanError(),
      "RECURRING_EDIT_CREATE_FAILED",
    );

    assert.equal(statusCode, 403);
    assert.equal(body.ok, false);
    assert.equal(body.success, false);
    assert.equal(body.code, "RECURRING_EDIT_PRO_PLAN_REQUIRED");
    assert.equal(
      body.message,
      "Recurring edits are available on paid plans. Please upgrade to continue.",
    );
    assert.equal(body.upgradeRequired, true);
    assert.equal(body.requiredPlan, "paid");
    assert.match(body.errorId, /^[a-f0-9]{16}$/);
    assert.equal(body.rootCause, undefined);
    assert.equal(body.stack, undefined);
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

test("recurring edit paid-plan gate does not expose stack in dev tunnels", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";

  try {
    const { body } = buildPublicApiErrorResponse(
      new RecurringEditPlanError(),
      "RECURRING_EDIT_CREATE_FAILED",
    );

    assert.equal(body.code, "RECURRING_EDIT_PRO_PLAN_REQUIRED");
    assert.equal(body.rootCause, undefined);
    assert.equal(body.stack, undefined);
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

test("recurring edit frontend handles plan gate once without toast duplication", () => {
  const modal = read(
    "web/frontend/Domain/products/edit/components/RecurringEditModal.jsx",
  );
  const mutation = read(
    "web/frontend/Domain/products/edit/hooks/useCreateRecurringEditMutation.js",
  );

  assert.ok(
    mutation.includes('"RECURRING_EDIT_PRO_PLAN_REQUIRED"') &&
      mutation.includes("detail?.upgradeRequired === true"),
    "Create recurring edit mutation must recognize recurring plan-gate responses",
  );
  assert.ok(
    mutation.indexOf("detail?.message") < mutation.indexOf("detail?.rootCause"),
    "Frontend must prefer public API message over internal rootCause",
  );
  assert.ok(
    modal.includes("if (mappedError.isUpgradeRequired)") &&
      modal.includes('setError("");') &&
      modal.includes("setUpgradeWarning(failureMessage);") &&
      !modal.includes("showError(failureMessage);\n        return;"),
    "RecurringEditModal must show plan gate inline without a duplicate error toast",
  );
});

test("recurring edit pricing and backend gate use the same paid-plan promise", () => {
  const plans = read("web/services/SubscriptionService/SubscriptionService.js");
  const fallbackPlans = read("web/frontend/Domain/Subscription/config/pricingPlans.js");
  const recurringGate = read("web/services/recurringEditPlanService.js");

  assert.ok(
    recurringGate.includes('"BASIC_MONTHLY"') &&
      recurringGate.includes('"ADVANCED_MONTHLY"') &&
      recurringGate.includes('"PRO_MONTHLY"'),
    "Recurring edit backend gate must allow every paid plan advertised with recurring edits",
  );
  assert.ok(
    plans.includes("BASIC_MONTHLY") &&
      plans.includes('"Recurring edits"') &&
      fallbackPlans.includes("BASIC_MONTHLY") &&
      fallbackPlans.includes('"Recurring edits"'),
    "Pricing surfaces must advertise recurring edits only in line with the backend paid-plan gate",
  );
  assert.equal(
    plans.includes("Unlimited Scheduled Edit") ||
      fallbackPlans.includes("20 recurring edits") ||
      fallbackPlans.includes("5 recurring edits"),
    false,
    "Pricing must not advertise recurring/scheduled quantities that backend gates do not enforce",
  );
});

test("recurring edit modal uses shop timezone source for schedule payloads", () => {
  const modal = read(
    "web/frontend/Domain/products/edit/components/RecurringEditModal.jsx",
  );
  const controller = read("web/controllers/recurringEditController.js");
  const storeAccess = read("web/services/storeAccessService.js");

  assert.ok(
    modal.includes("useShopTimezone") &&
      modal.includes("const { shopTimezone } = useShopTimezone();") &&
      modal.includes("const resolvedTimezone = normalizeRecurringEditTimezone(shopTimezone);"),
    "RecurringEditModal must normalize the shop/server timezone before submitting",
  );
  assert.ok(
    modal.includes('RECURRING_EDIT_UNSAFE_TIMEZONES = new Set(["America/New_York"])') &&
      modal.includes("RECURRING_EDIT_UNSAFE_TIMEZONES.has(normalized)") &&
      modal.includes("FALLBACK_TIMEZONE"),
    "RecurringEditModal must not let America/New_York become the recurring schedule timezone",
  );
  assert.ok(
    controller.includes("normalizeRecurringEditTimezone") &&
      storeAccess.includes('RECURRING_EDIT_UNSAFE_TIMEZONES = new Set(["America/New_York"])'),
    "Recurring edit backend must normalize unsafe shop timezones before saving",
  );
  assert.equal(
    modal.includes('const resolvedTimezone = "America/New_York"'),
    false,
    "RecurringEditModal must not default recurring schedules to America/New_York",
  );
});

test("recurring edit normalizer accepts modal create payload contract", () => {
  const command = buildCreateRecurringEditCommand({
    shop: "demo-shop.myshopify.com",
    actor: { type: "MERCHANT_ADMIN", userId: "staff-1" },
    idempotencyKey: "recurring-edit:test",
    subscription: { plan: "PRO_MONTHLY", status: "ACTIVE" },
    body: {
      title: "Daily price increase",
      frequency: "DAILY",
      timezone: "Asia/Kolkata",
      timeToRun: "12:00 PM",
      status: "ACTIVE",
      editedField: "price",
      editedBy: "increaseByPercentage",
      operation: "INCREASE_PERCENT",
      value: "20",
      filterParams: [],
      filterAst: {
        version: 1,
        targetGranularity: "PRODUCT",
        source: "RECURRING_DEFINITION",
        filters: [],
      },
      filterFingerprint: "filter-123",
      targetingFingerprint: "target-123",
      previewContractId: "preview-123",
      previewId: "preview-123",
      previewFilterHash: "filter-123",
      previewSignature: "sig-123",
      approvedPreviewCount: 3,
    },
  });

  assert.equal(command.input.name, "Daily price increase");
  assert.equal(command.input.title, "Daily price increase");
  assert.equal(command.input.startAt, null);
  assert.equal(command.input.timeToRun, "12:00");
  assert.equal(command.input.runTime, "12:00");
  assert.equal(command.input.timezone, "Asia/Kolkata");
  assert.equal(command.input.editedField, "price");
  assert.equal(command.input.editedBy, "increaseByPercentage");
  assert.equal(command.input.operation, "INCREASE_PERCENT");
  assert.equal(command.input.value, "20");
  assert.deepEqual(command.input.editPayload, {});
  assert.equal(command.input.status, "ACTIVE");
  assert.equal(command.input.previewContractId, "preview-123");
  assert.equal(command.input.previewFilterHash, "filter-123");
  assert.equal(command.input.previewSignature, "sig-123");
});

test("recurring edit controller derives trusted actor instead of browser actor", () => {
  const controller = read("web/controllers/recurringEditController.js");

  assert.ok(
    controller.includes('type: "MERCHANT_USER"') &&
      controller.includes("userId") &&
      controller.includes('source: "SHOPIFY_ADMIN"'),
    "Recurring create actor must be derived from the authenticated Shopify session",
  );
  assert.equal(
    controller.includes("actor: buildAuthenticatedActor(req, session)"),
    false,
    "Recurring controller must not use actor helpers that produce actorType/actorId for this normalizer",
  );
});
