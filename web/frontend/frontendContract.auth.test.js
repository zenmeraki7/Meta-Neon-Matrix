import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

test("protected critical frontend flows do not use raw fetch", () => {
  const files = [
    "web/frontend/Domain/products/list/hooks/useProducts.js",
    "web/frontend/Domain/products/list/pages/Products.jsx",
    "web/frontend/Domain/products/edit/pages/EditPreviewPage.jsx",
    "web/frontend/Domain/products/exports/pages/ExportPage.jsx",
    "web/frontend/Domain/settings/sync/pages/SyncPage.jsx",
    "web/frontend/hooks/useProductSyncStatus.js",
    "web/frontend/Domain/products/edit/components/ScheduleEdit.jsx",
    "web/frontend/Domain/products/edit/components/RecurringEditModal.jsx",
    "web/frontend/Domain/products/edit/components/ValueInput.jsx",
    "web/frontend/Domain/History/services/historyService.js",
  ];

  for (const file of files) {
    const content = read(file);
    assert.equal(
      /\bfetch\s*\(/.test(content),
      false,
      `Raw fetch is not allowed in protected flow: ${file}`,
    );
  }
});

test("frontend does not send hardcoded shop authority", () => {
  const file = "web/frontend/Domain/products/exports/pages/ExportPage.jsx";
  const content = read(file);
  assert.equal(
    /shop\s*:\s*["'][^"']+\.myshopify\.com["']/.test(content),
    false,
    "Hardcoded shop authority detected in export payload",
  );
});

test("embedded-safe navigation avoids window.open/location.assign in core providers", () => {
  const polarisProvider = read("web/frontend/components/providers/PolarisProvider.jsx");
  const authFetchHook = read("web/frontend/hooks/useAuthenticatedFetch.js");
  assert.equal(/window\.open\(/.test(polarisProvider), false, "window.open found in PolarisProvider");
  assert.equal(
    /window\.location\.assign\(/.test(authFetchHook),
    false,
    "window.location.assign found in useAuthenticatedFetch",
  );
});

test("bulk edit flow avoids native confirm and enforces modal/location/fresh-preview guards", () => {
  const editPreview = read("web/frontend/Domain/products/edit/pages/EditPreviewPage.jsx");
  assert.equal(/window\.confirm\(/.test(editPreview), false, "window.confirm found in EditPreviewPage");
  assert.equal(editPreview.includes("confirmModalOpen"), true, "Broad target confirmation modal guard missing");
  assert.equal(editPreview.includes("hasRequiredLocation"), true, "Location-required guard missing");
  assert.equal(editPreview.includes("buildCurrentPreviewSignature"), true, "Fresh preview signature guard missing");
});

test("tailwind primitive import removed from app.css", () => {
  const appCss = read("web/frontend/app.css");
  assert.equal(/@import\s+["']tailwindcss["']/.test(appCss), false, "Tailwind primitive import should be removed");
});
