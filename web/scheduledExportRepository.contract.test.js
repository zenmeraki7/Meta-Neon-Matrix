import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync("web/repositories/scheduledExportRepository.js", "utf8");

test("scheduled export create requires shop", () => {
  assert.match(source, /function assertPlainCreateData\(data\)/);
  assert.match(source, /SCHEDULED_EXPORT_CREATE_REQUIRES_SHOP/);
  assert.match(source, /db\.scheduledExport\.create\(\{ data: assertPlainCreateData\(data\) \}\)/);
});

test("scheduled export update strips immutable tenant fields", () => {
  assert.match(source, /function stripImmutableTenantFields\(data = \{\}\)/);
  assert.match(source, /SCHEDULED_EXPORT_UPDATE_DATA_INVALID/);
  assert.doesNotMatch(source, /return \{\};/);
  assert.match(source, /id: _id/);
  assert.match(source, /shop: _shop/);
  assert.match(source, /createdAt: _createdAt/);
  assert.match(source, /data: stripImmutableTenantFields\(data\)/);
  assert.match(source, /where: \{ id, shop \}/);
});

test("scheduled export list is paginated and supports cursor", () => {
  assert.match(source, /const DEFAULT_LIST_LIMIT = 100/);
  assert.match(source, /const MAX_LIST_LIMIT = 250/);
  assert.match(source, /async listByShop\(shop, options = \{\}, db = prisma\)/);
  assert.doesNotMatch(source, /resolveListByShopArgs/);
  assert.match(source, /take: limit/);
  assert.match(source, /cursor: \{ id: cursorId \}, skip: 1/);
});

test("scheduled export due scheduler remains explicitly shop-scoped", () => {
  assert.match(source, /findDueScheduledExportIds requires shop; use findDueScheduledExportIdsForShop/);
  assert.match(source, /Scheduler path is intentionally shop-scoped/);
  assert.match(source, /function boundedDueLimit\(limit\)/);
  assert.match(source, /scheduled export due limit must not exceed \$\{MAX_DUE_LIMIT\}/);
  assert.match(source, /take: boundedDueLimit\(limit\)/);
});

test("scheduled export repository uses injected db directly", () => {
  assert.doesNotMatch(source, /function getClient/);
  assert.doesNotMatch(source, /getClient\(db\)/);
});

test("scheduled export find by id is fully scoped", () => {
  assert.match(source, /SCHEDULED_EXPORT_FIND_REQUIRES_ID/);
  assert.match(source, /assertShop\(shop, "SCHEDULED_EXPORT_FIND_REQUIRES_SHOP"\)/);
  assert.match(source, /where: \{\s*id,\s*shop,\s*isDeleted: false,/s);
});
