import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync(
  new URL(
    "./Domain/products/edit/hooks/useEditPreviewQuery.js",
    import.meta.url
  ),
  "utf8"
);
const pageSource = readFileSync(
  new URL("./Domain/products/edit/pages/EditPreviewPage.jsx", import.meta.url),
  "utf8"
);

test("edit preview query uses a canonical payload identity", () => {
  assert.match(hookSource, /createEditPreviewPayloadHash\(payload\)/);
  assert.match(hookSource, /createEditPreviewRequestKey\(payload\)/);
  assert.match(hookSource, /safeQueryKeyHash === payloadHash/);
  assert.match(hookSource, /payloadHash/);
  assert.match(
    pageSource,
    /createEditPreviewPayloadHash\(previewQueryPayload\)/
  );
  assert.match(
    pageSource,
    /createEditPreviewRequestKey\(previewQueryPayload\)/
  );
});

test("edit preview query does not reuse rows across request keys", () => {
  assert.match(hookSource, /previous\?\.requestKey === requestKey/);
  assert.doesNotMatch(
    hookSource,
    /placeholderData:\s*\(previous\)\s*=>\s*previous/
  );
});

test("run edit freshness compares request key, not server preview signature", () => {
  assert.match(pageSource, /previewRequestKey === currentPreviewRequestKey/);
  assert.match(pageSource, /previewFingerprint\?\.normalizedFilterHash/);
  assert.match(pageSource, /previewFingerprint\?\.mirrorBatchId/);
  assert.match(pageSource, /previewRegistryVersion\?\.fieldRegistryVersion/);
  assert.match(pageSource, /previewRegistryVersion\?\.operatorRegistryVersion/);
  assert.doesNotMatch(
    pageSource,
    /previewSignature === currentPreviewSignature/
  );
  assert.match(pageSource, /previewSignature,/);
  assert.match(
    hookSource,
    /previewSignature: safeString\(data\?\.previewSignature, ""\)/
  );
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
    /targetSnapshotId = safeString\(data\?\.targetSnapshotId/
  );
  assert.match(
    hookSource,
    /normalizedFilterHash = safeString\(previewFingerprint\?\.normalizedFilterHash/
  );
});
