import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildEditIntentFromRules,
  buildHistoryTitle,
  normalizeField,
  normalizeRules,
  resolveTargetGranularityFromRules,
} from "./services/bulkEdit/bulkEditRuleUtils.js";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");

test("bulk edit rule utils do not re-export legacy planner helpers or translate titles", () => {
  const source = read("web/services/bulkEdit/bulkEditRuleUtils.js");
  assert.equal(source.includes("../productService/helpers/bulkEditOperationHelpers.js"), false);
  assert.equal(source.includes("createMultiLanguage"), false);
  assert.equal(source.includes("googleTranslator"), false);
  assert.equal(source.includes("export { buildExecutionPlanForEdit, getPlanMaxBulkEditTargets }"), false);
});

test("bulk edit service family callers use canonical bulk edit helpers", () => {
  const scheduledSource = read("web/services/bulkEdit/ScheduledEditService.js");
  assert.equal(scheduledSource.includes("../productService/helpers/bulkEditOperationHelpers.js"), false);
  assert.equal(scheduledSource.includes("createMultiLanguage"), false);
  assert.equal(scheduledSource.includes("googleTranslator"), false);
  assert.ok(scheduledSource.includes("./bulkEditPlanUtils.js"));
  assert.ok(scheduledSource.includes("./bulkEditRuleUtils.js"));
});

test("scheduled edit service is the implementation, not a constructor-shim wrapper", () => {
  const scheduledSource = read("web/services/bulkEdit/ScheduledEditService.js");
  const productBulkSource = read("web/services/bulkEdit/ProductBulkService.js");

  assert.equal(fs.existsSync(path.resolve("web/services/bulkEdit/ScheduledEditService.impl.js")), false);
  assert.equal(scheduledSource.includes("extends ScheduledEditServiceImpl"), false);
  assert.equal(scheduledSource.includes("sessionOrOptions?.session || sessionOrOptions"), false);
  assert.equal(scheduledSource.includes("new BulkEditTargetFreezeService"), false);
  assert.ok(scheduledSource.includes("constructor({"));
  assert.ok(productBulkSource.includes("new ScheduledEditService({"));
  assert.ok(productBulkSource.includes("freezeEditHistoryTargets:"));
});

test("normalizeField canonicalizes case and aliases, and rejects missing fields", () => {
  assert.equal(normalizeField("COMPARE_AT_PRICE"), "compareAtPrice");
  assert.equal(normalizeField("ProductType"), "productType");
  assert.equal(normalizeField("option_2_name"), "option2Name");
  assert.throws(() => normalizeField(null), /BULK_EDIT_RULE_FIELD_REQUIRED/);
  assert.throws(() => normalizeField(" "), /BULK_EDIT_RULE_FIELD_REQUIRED/);
});

test("normalizeRules accepts exactly one rule input shape", () => {
  assert.deepEqual(normalizeRules({
    editedField: "Compare_At_Price",
    editType: "set",
    editValue: "12.50",
  }), [{
    field: "compareAtPrice",
    value: "12.50",
    editOption: "set",
    operator: "set",
    searchKey: null,
    replaceText: null,
    supportValue: null,
    locationId: null,
  }]);

  assert.throws(() => normalizeRules({
    editedField: "title",
    rules: [{ field: "price", value: "10" }],
  }), /BULK_EDIT_RULE_INPUT_SHAPE_AMBIGUOUS/);
  assert.throws(() => normalizeRules({}), /BULK_EDIT_RULE_FIELD_REQUIRED/);
});

test("edit intent preserves the normalized rule shape", () => {
  const intent = buildEditIntentFromRules([
    { field: "SKU", editOption: "append", value: "A" },
  ]);
  assert.deepEqual(intent, [{
    field: "sku",
    editOption: "append",
    operator: "append",
    value: "A",
    supportValue: null,
    searchKey: null,
    replaceText: null,
    locationId: null,
  }]);
});

test("target granularity distinguishes product, variant, and mixed rules", () => {
  assert.equal(resolveTargetGranularityFromRules([{ field: "title" }]), "PRODUCT");
  assert.equal(resolveTargetGranularityFromRules([{ field: "price" }]), "VARIANT");
  assert.equal(
    resolveTargetGranularityFromRules([{ field: "title" }, { field: "price" }]),
    "PRODUCT_WITH_MATCHING_VARIANTS",
  );
});

test("buildHistoryTitle returns a local title string", () => {
  const title = buildHistoryTitle([{ field: "title", editOption: "set", value: "New title" }]);
  assert.equal(typeof title, "string");
  assert.notEqual(title.trim(), "");
});
