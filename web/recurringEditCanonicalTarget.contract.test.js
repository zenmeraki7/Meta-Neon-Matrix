import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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
