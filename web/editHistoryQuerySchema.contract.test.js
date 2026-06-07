import test from "node:test";
import assert from "node:assert/strict";
import editHistoryQuerySchema from "./validations/editHistoryQuerySchema.js";

function validate(query) {
  return editHistoryQuerySchema.validate(query, { abortEarly: false });
}

test("edit history query schema accepts canonical type filters only", () => {
  assert.equal(validate({ type: "Recurring edit" }).error, undefined);
  assert.equal(validate({ type: "Automatic rule" }).error, undefined);
  assert.equal(validate({ type: "Favorites" }).error, undefined);
  assert.match(validate({ type: "Reccuring edit" }).error?.message || "", /type/);
});

test("edit history query schema bounds text inputs and rejects unknown keys", () => {
  assert.equal(validate({ search: "title", cursor: "cursor-1", lang: "en-US", limit: 100 }).error, undefined);
  assert.match(validate({ search: "x".repeat(501) }).error?.message || "", /search/);
  assert.match(validate({ cursor: "x".repeat(501) }).error?.message || "", /cursor/);
  assert.match(validate({ lang: "not a language code" }).error?.message || "", /lang/);
  assert.match(validate({ unexpected: "field" }).error?.message || "", /unexpected/);
});
