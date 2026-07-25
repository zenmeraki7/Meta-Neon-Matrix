import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editTypeSelectorSource = readFileSync(
  new URL("./Domain/products/edit/components/EditTypeSelector.jsx", import.meta.url),
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

test("edit type selector emits only stable action values", () => {
  assert.match(editTypeSelectorSource, /selectedFieldValue/);
  assert.match(editTypeSelectorSource, /onEditTypeChange\(value \|\| null\)/);
  assert.doesNotMatch(editTypeSelectorSource, /onEditTypeChange\(selected/);
  assert.doesNotMatch(editTypeSelectorSource, /selectedField,\s*\n\s*editType/);
});

test("edit type selector uses lowercase translation keys and warns on bad registry entries", () => {
  assert.match(editTypeSelectorSource, /products:howToEdit/);
  assert.doesNotMatch(editTypeSelectorSource, /products:HowToEdit/);
  assert.match(editTypeSelectorSource, /import\.meta\.env\.DEV/);
  assert.match(editTypeSelectorSource, /Duplicate edit action value:/);
  assert.match(editTypeSelectorSource, /Invalid edit action definition\./);
});

test("edit type selector uses registry label keys and map lookup", () => {
  assert.match(constantsSource, /labelKey/);
  assert.match(constantsSource, /defaultLabel/);
  assert.match(editTypeSelectorSource, /new Map\(editOptions\.map/);
  assert.doesNotMatch(editTypeSelectorSource, /new Set\(editOptions\.map/);
  assert.match(editTypeSelectorSource, /t\(option\.labelKey/);
  assert.match(editTypeSelectorSource, /defaultValue: option\.defaultLabel/);
});

test("disabled edit type selector explains why selection is blocked", () => {
  assert.match(editTypeSelectorSource, /helpText/);
  assert.match(editTypeSelectorSource, /selectFieldBeforeEditType/);
  assert.match(editTypeSelectorSource, /noEditActionsAvailable/);
});

test("parent stores the action value, derives the action, and resets dependent state", () => {
  assert.match(editPreviewPageSource, /function resolveEditTypeSelection/);
  assert.match(editPreviewPageSource, /const \[editTypeValue, setEditTypeValue\] = useState\(null\)/);
  assert.match(editPreviewPageSource, /resolveEditTypeSelection\(selectedField, editTypeValue\)/);
  assert.match(editPreviewPageSource, /setEditTypeValue\(nextEditTypeValue\)/);
  assert.match(editPreviewPageSource, /selectedFieldValue=\{selectedField\?\.value\}/);
  assert.match(editPreviewPageSource, /editType=\{editTypeValue\}/);
  assert.match(editPreviewPageSource, /setRounding\("NONE"\)/);
  assert.match(editPreviewPageSource, /setDraftInputValue\(null\)/);
  assert.match(editPreviewPageSource, /setInputValue\(null\)/);
  assert.match(editPreviewPageSource, /setSupportValue\(null\)/);
  assert.match(editPreviewPageSource, /setDraftSearchReplace\(\{ search: "", replace: "" \}\)/);
  assert.match(editPreviewPageSource, /setSearchReplace\(\{ search: "", replace: "" \}\)/);
  assert.match(editPreviewPageSource, /setLocationValue\(""\)/);
  assert.match(editPreviewPageSource, /setDestructiveConfirmationValue\(""\)/);
});
