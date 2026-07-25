import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fieldSelectorSource = readFileSync(
  new URL("./Domain/products/edit/components/FieldSelector.jsx", import.meta.url),
  "utf8",
);
const editPreviewPageSource = readFileSync(
  new URL("./Domain/products/edit/pages/EditPreviewPage.jsx", import.meta.url),
  "utf8",
);
const constantsSource = readFileSync(
  new URL("./Domain/products/edit/constants.js", import.meta.url),
  "utf8",
);

test("field selector imports a stable normalized field registry", () => {
  assert.match(constantsSource, /NORMALIZED_EDIT_FIELDS/);
  assert.match(constantsSource, /labelKey/);
  assert.match(constantsSource, /defaultLabel/);
  assert.doesNotMatch(fieldSelectorSource, /getAllFields\(/);
  assert.match(fieldSelectorSource, /NORMALIZED_EDIT_FIELDS/);
});

test("field selector does not pass translated field objects into parent state", () => {
  assert.match(fieldSelectorSource, /function toSelectedFieldPayload/);
  assert.match(fieldSelectorSource, /riskLevel/);
  assert.match(fieldSelectorSource, /confirmationPhrase/);
  assert.match(
    fieldSelectorSource,
    /onFieldChange\(toSelectedFieldPayload\(fieldByValue\.get\(nextValue\)\)\)/,
  );
  assert.doesNotMatch(fieldSelectorSource, /onFieldChange\(fieldByValue\.get/);
});

test("field selector caps autocomplete DOM aggressively", () => {
  assert.match(fieldSelectorSource, /MAX_OPTIONS_PER_CATEGORY = 15/);
  assert.match(fieldSelectorSource, /MAX_TOTAL_OPTIONS = 40/);
  assert.match(fieldSelectorSource, /COMMON_EDIT_FIELD_VALUES/);
});

test("field selector pre-groups fields and uses tokenized search", () => {
  assert.match(fieldSelectorSource, /const fieldsByCategory = useMemo/);
  assert.match(fieldSelectorSource, /function tokenize/);
  assert.match(fieldSelectorSource, /queryTokens\.every/);
  assert.match(fieldSelectorSource, /field\.searchTokens\.includes\(token\)/);
});

test("parent resolves canonical field state and blocks risky field workflows", () => {
  assert.match(editPreviewPageSource, /function resolveFieldSelection/);
  assert.match(editPreviewPageSource, /getFieldDefinition\(fieldValue\)/);
  assert.match(editPreviewPageSource, /requiresFieldConfirmation/);
  assert.match(editPreviewPageSource, /hasFieldConfirmation/);
  assert.match(editPreviewPageSource, /hasRequiredConfirmation/);
  assert.match(editPreviewPageSource, /previewQueryEnabled[\s\S]*hasRequiredConfirmation/);
});

