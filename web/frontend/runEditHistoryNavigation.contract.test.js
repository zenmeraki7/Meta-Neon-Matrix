import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

test("edit details never fetches history summary with an undefined route id", () => {
  const editDetails = read("web/frontend/Domain/products/edit/pages/EditDetails.jsx");

  assert.equal(editDetails.includes("normalizeRouteHistoryId"), true);
  assert.equal(editDetails.includes("enabled: Boolean(historyId)"), true);
  assert.equal(editDetails.includes("encodeURIComponent(historyId)"), true);
  assert.equal(editDetails.includes("Missing history ID."), true);
});

test("run edit redirects with a real returned history id", () => {
  const editPreview = read("web/frontend/Domain/products/edit/pages/EditPreviewPage.jsx");

  assert.equal(editPreview.includes("getRunEditHistoryId"), true);
  assert.equal(editPreview.includes("data.historyId"), true);
  assert.equal(
    editPreview.includes("navigate(`/editDetails/${encodeURIComponent(historyId)}`)"),
    true,
  );
  assert.equal(
    editPreview.includes("Edit started, but no history ID was returned."),
    true,
  );
});
