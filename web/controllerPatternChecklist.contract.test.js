import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("preview controller follows authenticate-normalize-validate-delegate-dto pattern", () => {
  const source = read("web/controllers/productBulkEditController.js");
  assert.ok(source.includes("session = getSessionOrThrow(res)"));
  assert.ok(source.includes("const command = normalizeBulkEditExecuteBody(req.body, req.query)"));
  assert.ok(source.includes("service.trackEditProducts"));
  assert.ok(source.includes("return res.status(200).json(toPreviewDto(result));"));
});

test("execute controller enforces previewId + fingerprint and delegates to command service", () => {
  const source = read("web/controllers/productBulkEditController.js");
  assert.ok(source.includes("assertExecutePreviewFingerprint(command);"));
  assert.ok(source.includes("service.bulkEditProducts({"));
  assert.ok(source.includes('idempotencyKey: req.headers["idempotency-key"]'));
  assert.ok(source.includes("operationId: result.operationId || result.id"));
});

test("undo controller delegates to undo command service and returns undoOperationId", () => {
  const source = read("web/controllers/productBulkEditController.js");
  assert.ok(source.includes("const service = new UndoEditService(session);"));
  assert.ok(source.includes("const result = await service.undoEdit(id);"));
  assert.ok(source.includes("undoOperationId: result?.data?.id || id"));
});

test("scheduled controller normalizes schedule, validates freezeMode, delegates, returns scheduledOperationId", () => {
  const source = read("web/controllers/productBulkEditController.js");
  assert.ok(source.includes("const command = normalizeScheduledEditBody(req.body);"));
  assert.ok(source.includes("assertValidFreezeMode(command.freezeMode);"));
  assert.ok(source.includes("bulkService.createScheduledEdit({"));
  assert.ok(source.includes("scheduledOperationId: history.id"));
});
