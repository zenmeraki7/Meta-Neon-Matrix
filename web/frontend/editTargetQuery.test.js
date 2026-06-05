import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEditTargetSearch,
  parseEditTargetSearch,
} from "./Domain/products/list/utils/editTargetQuery.js";

test("edit target query round-trips canonical filters", () => {
  const filters = [
    { field: "productType", operator: "equals", value: "Winter product" },
    { field: "search", operator: "contains", value: "ROJAL FASHION STORE NEW" },
  ];

  const search = buildEditTargetSearch(filters);
  const parsed = parseEditTargetSearch(search);

  assert.equal(parsed.hasTarget, true);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.filterParams, filters);
});

test("edit target query reports invalid payloads", () => {
  const parsed = parseEditTargetSearch("?target=%7Bbad-json");

  assert.equal(parsed.hasTarget, true);
  assert.equal(Array.isArray(parsed.filterParams), true);
  assert.ok(parsed.error);
});

test("empty filter target omits query string", () => {
  assert.equal(buildEditTargetSearch([]), "");
});
