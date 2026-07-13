import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");

test("bulk edit execute schema requires preview fingerprint + registry versions", () => {
  const src = read("web/validations/controllerRequestSchemas.js");
  assert.ok(src.includes("previewId: Joi.string().required()"));
  assert.ok(src.includes("previewFilterHash: Joi.string().required()"));
  assert.ok(src.includes("previewMirrorBatchId: Joi.string().required()"));
  assert.ok(
    src.includes("previewFieldRegistryVersion: Joi.string().required()")
  );
  assert.ok(
    src.includes("previewOperatorRegistryVersion: Joi.string().required()")
  );
});

test("undo endpoint is canonical, authenticated, and idempotency-keyed", () => {
  const historyRouteSrc = read("web/routes/HistoryRoutes.js");
  const productRouteSrc = read("web/routes/productRoutes.js");
  const controllerSrc = read("web/controllers/historyUndoController.js");
  const useCaseSrc = read("web/useCases/productBulkEditUseCases.js");
  assert.ok(historyRouteSrc.includes('"/:historyId/undo"'));
  assert.ok(historyRouteSrc.includes("validateSession"));
  assert.equal(productRouteSrc.includes("undo-edit"), false);
  assert.ok(controllerSrc.includes('req.get?.("Idempotency-Key")'));
  assert.ok(useCaseSrc.includes("assertHistoryMutationCommand(command)"));
  assert.ok(
    useCaseSrc.includes("const undoInput = toUndoServiceInput(command);")
  );
  assert.ok(useCaseSrc.includes("service.undoEdit(undoInput.historyId"));
  assert.ok(useCaseSrc.includes("idempotencyKey: undoInput.idempotencyKey"));
  assert.ok(useCaseSrc.includes('"IDEMPOTENCY_KEY_REQUIRED"'));
});

test("preview contract emits deterministic fingerprint fields", () => {
  const src = read("web/services/productService/ProductBulkPreviewService.js");
  const dtoSrc = read("web/dtos/productBulkEditDto.js");
  assert.ok(src.includes("previewSignatureHash"));
  assert.ok(src.includes("registryVersion"));
  assert.ok(src.includes("filterHash"));
  assert.ok(src.includes("mirrorBatchId"));
  assert.ok(dtoSrc.includes("previewFingerprint"));
  assert.ok(
    dtoSrc.includes("requiresConfirmation: data?.requiresConfirmation === true")
  );
  assert.equal(
    dtoSrc.includes("// Backward-compatible top-level fields"),
    false
  );
});

test("admin recovery endpoint requires idempotency key and uses idempotency scope", () => {
  const controllerSrc = read("web/controllers/adminController.js");
  const serviceSrc = read("web/services/adminService.js");
  assert.ok(
    controllerSrc.includes(
      'const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();'
    )
  );
  assert.ok(controllerSrc.includes("IDEMPOTENCY_KEY_REQUIRED"));
  assert.ok(serviceSrc.includes('scope: "BULK_EDIT_RECOVERY_API"'));
});
