import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./Domain/products/edit/hooks/useFiledValidation.ts", import.meta.url),
  "utf8",
);

test("form validation uses pure validation instead of calling hooks in loops", () => {
  assert.match(source, /export function validateFieldValue/);
  assert.match(source, /const error = validateFieldValue\(value, rules, t\)/);
  assert.doesNotMatch(source, /const error = useFieldValidation\(value, rules\)/);
});

test("field validation hooks call translation only at hook top level", () => {
  assert.match(source, /const \{ t \} = useTranslation\(\);/);
  assert.match(source, /\(\) => validateFieldValue\(value, rules, t\)/);
});
