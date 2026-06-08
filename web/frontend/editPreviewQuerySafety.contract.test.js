import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync(
  new URL("./Domain/products/edit/hooks/useEditPreviewQuery.js", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(
  new URL("./Domain/products/edit/pages/EditPreviewPage.jsx", import.meta.url),
  "utf8",
);

test("edit preview query uses a canonical payload identity", () => {
  assert.match(hookSource, /createEditPreviewPayloadHash\(payload\)/);
  assert.match(hookSource, /safeQueryKeyHash === payloadHash/);
  assert.match(hookSource, /payloadHash: previewSignature/);
  assert.match(pageSource, /createEditPreviewPayloadHash\(previewQueryPayload\)/);
});

test("edit preview query does not reuse rows across payload signatures", () => {
  assert.match(
    hookSource,
    /previous\?\.previewSignature === previewSignature/,
  );
  assert.doesNotMatch(hookSource, /placeholderData:\s*\(previous\)\s*=>\s*previous/);
});

test("edit preview request is validated and explicitly projected", () => {
  assert.match(hookSource, /const canPreview =/);
  assert.match(hookSource, /encodeURIComponent\(safeLanguage\)/);
  assert.match(hookSource, /Invalid edit preview response: missing rows/);
  assert.match(hookSource, /buildEditPreviewRequestBody/);
  assert.doesNotMatch(hookSource, /\.\.\.payload/);
});

test("edit preview payload uses canonical filters and scalar identities", () => {
  assert.match(hookSource, /filterAst/);
  assert.match(hookSource, /filterFingerprint/);
  assert.match(hookSource, /filterVersion/);
  assert.match(hookSource, /normalizeSupportValue\(supportValue\)/);
  assert.doesNotMatch(hookSource, /selectedField\?\.value/);
  assert.doesNotMatch(hookSource, /editType\?\.value/);
  assert.match(pageSource, /selectedFieldValue:\s*selectedField\?\.value/);
  assert.match(pageSource, /editTypeValue/);
});

test("preview response keeps snapshot and filter identities separate", () => {
  assert.match(
    hookSource,
    /targetSnapshotId = safeString\(data\?\.targetSnapshotId/,
  );
  assert.match(
    hookSource,
    /filterHash = safeString\(previewFingerprint\?\.filterHash/,
  );
});
