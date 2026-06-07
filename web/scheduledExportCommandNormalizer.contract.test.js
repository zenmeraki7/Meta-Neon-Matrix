import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeGetScheduledExportCommand,
  normalizeListScheduledExportsCommand,
  normalizeCreateScheduledExportCommand,
} from "./normalizers/scheduledExportCommandNormalizer.js";

const locals = {
  shopify: { session: { shop: "example.myshopify.com" } },
  entitlement: {
    shop: "example.myshopify.com",
    planKey: "PRO",
    planName: "Pro",
    limit: "unlimited",
  },
};

const read = (file) => fs.readFileSync(path.resolve(file), "utf8");

test("scheduled export normalizer uses shared plain object primitive", () => {
  const source = read("web/normalizers/scheduledExportCommandNormalizer.js");

  assert.ok(source.includes("isPlainObject,"));
  assert.equal(source.includes("function isPlainObject"), false);
});

test("scheduled export ids and cursors must use safe token format", () => {
  assert.equal(
    normalizeGetScheduledExportCommand({ id: "sched_123:abc" }, {}, locals).scheduledExportId,
    "sched_123:abc",
  );

  assert.throws(
    () => normalizeGetScheduledExportCommand({ id: "../../etc/passwd" }, {}, locals),
    (error) => error.fields?.[0]?.field === "id" && error.fields?.[0]?.error === "invalid format",
  );

  assert.throws(
    () => normalizeListScheduledExportsCommand({ cursorId: "../../etc/passwd" }, {}, locals),
    (error) => error.fields?.[0]?.field === "cursorId",
  );
});

test("scheduled export list command exposes bounded pagination", () => {
  const command = normalizeListScheduledExportsCommand(
    { limit: "125", cursorId: "sched_cursor_1" },
    {},
    locals,
  );

  assert.deepEqual(command, {
    shop: "example.myshopify.com",
    limit: 125,
    cursorId: "sched_cursor_1",
  });
  assert.equal(Object.isFrozen(command), true);

  assert.throws(
    () => normalizeListScheduledExportsCommand({ limit: "251" }, {}, locals),
    /Validation failed/,
  );
});

test("scheduled export subscription limit is numeric or null", () => {
  const invalidLimit = normalizeCreateScheduledExportCommand(
    {},
    { fields: ["ProductID"] },
    locals,
  ).subscription.limit;

  const numericLimit = normalizeCreateScheduledExportCommand(
    {},
    { fields: ["ProductID"] },
    { ...locals, entitlement: { ...locals.entitlement, limit: "50" } },
  ).subscription.limit;

  assert.equal(invalidLimit, null);
  assert.equal(numericLimit, 50);
});

test("scheduled export service forwards list pagination to repository", () => {
  const service = read("web/services/scheduledExportService.js");

  assert.ok(service.includes("listScheduledExports({ shop, limit, cursorId })"));
  assert.ok(service.includes("scheduledExportRepository.listByShop(shop, { limit, cursorId })"));
});
