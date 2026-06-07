import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");

test("bulk edit execute schema requires preview fingerprint + registry versions", () => {
  const src = read("web/validations/controllerRequestSchemas.js");
  assert.match(src, /previewId: previewIdSchema\.required\(\)/);
  assert.match(src, /previewFilterHash: previewFilterHashSchema\.required\(\)/);
  assert.match(src, /previewMirrorBatchId: previewMirrorBatchIdSchema\.required\(\)/);
  assert.match(src, /previewFieldRegistryVersion: Joi\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)\.required\(\)/);
  assert.match(src, /previewOperatorRegistryVersion: Joi\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)\.required\(\)/);
});

test("undo endpoint is subscription-gated and requires idempotency key in controller", () => {
  const routeSrc = read("web/routes/productRoutes.js");
  const controllerSrc = read("web/controllers/productBulkEditController.js");
  assert.ok(routeSrc.includes('router.put("/undo-edit/:id", subscriptionMiddleware, undoEdit);'));
  assert.ok(controllerSrc.includes('const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();'));
  assert.ok(controllerSrc.includes("IDEMPOTENCY_KEY_REQUIRED"));
});

test("preview contract emits deterministic fingerprint fields", () => {
  const src = read("web/services/productService/ProductBulkPreviewService.js");
  const controllerSrc = read("web/controllers/productBulkEditController.js");
  assert.ok(src.includes("previewSignatureHash"));
  assert.ok(src.includes("registryVersion"));
  assert.ok(src.includes("filterHash"));
  assert.ok(src.includes("mirrorBatchId"));
  assert.ok(controllerSrc.includes("data: {"));
  assert.ok(controllerSrc.includes("preview: normalizedPreviewRows"));
  assert.ok(controllerSrc.includes("previewFingerprint: normalizedFingerprint"));
  assert.ok(controllerSrc.includes("requiresConfirmation: Boolean"));
  assert.equal(controllerSrc.includes("// Backward-compatible top-level fields"), false);
});

test("admin recovery endpoint requires idempotency key and uses idempotency scope", () => {
  const src = read("web/controllers/adminController.js");
  assert.ok(src.includes('const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();'));
  assert.ok(src.includes("IDEMPOTENCY_KEY_REQUIRED"));
  assert.ok(src.includes('scope: "BULK_EDIT_RECOVERY_API"'));
});
