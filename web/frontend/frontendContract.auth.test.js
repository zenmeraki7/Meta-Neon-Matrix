import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  setAuthenticatedFetch,
  getAuthenticatedFetch,
} from "./api/authenticatedFetchRegistry.js";
import { bootstrapAuthenticatedFetch } from "./bootstrap/appBridgeBootstrap.js";

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
      `Raw fetch is not allowed in protected flow: ${file}`
    );
  }
});

test("frontend does not send hardcoded shop authority", () => {
  const file = "web/frontend/Domain/products/exports/pages/ExportPage.jsx";
  const content = read(file);
  assert.equal(
    /shop\s*:\s*["'][^"']+\.myshopify\.com["']/.test(content),
    false,
    "Hardcoded shop authority detected in export payload"
  );
});

test("embedded-safe navigation avoids window.open/location.assign in core providers", () => {
  const polarisProvider = read(
    "web/frontend/components/providers/PolarisProvider.jsx"
  );
  const authFetchHook = read("web/frontend/hooks/useAuthenticatedFetch.js");
  const authenticatedFetchHelper = read(
    "web/frontend/api/shopifyAuthenticatedFetch.js"
  );
  assert.equal(
    /window\.open\(/.test(polarisProvider),
    false,
    "window.open found in PolarisProvider"
  );
  assert.equal(
    /window\.location\.assign\(/.test(authFetchHook),
    false,
    "window.location.assign found in useAuthenticatedFetch"
  );
  assert.equal(
    /@shopify\/app-bridge\/utilities/.test(
      authFetchHook + authenticatedFetchHelper
    ),
    false,
    "App Bridge v3 authenticatedFetch utility is incompatible with App Bridge React v4"
  );
  assert.equal(
    /headers\.set\(["']Authorization["'],\s*`Bearer\s+\$\{token\}`\)/.test(
      authenticatedFetchHelper
    ),
    true,
    "useAuthenticatedFetch should attach an App Bridge session token before using window.fetch"
  );
  assert.equal(
    /APP_BRIDGE_CONTEXT_MISSING/.test(authenticatedFetchHelper),
    true,
    "useAuthenticatedFetch should fail closed when Shopify auth is unavailable"
  );
});

test("bulk edit flow avoids native confirm and enforces modal/location/fresh-preview guards", () => {
  const editPreview = read(
    "web/frontend/Domain/products/edit/pages/EditPreviewPage.jsx"
  );
  assert.equal(
    /window\.confirm\(/.test(editPreview),
    false,
    "window.confirm found in EditPreviewPage"
  );
  assert.equal(
    editPreview.includes("confirmModalOpen"),
    true,
    "Broad target confirmation modal guard missing"
  );
  assert.equal(
    editPreview.includes("hasRequiredLocation"),
    true,
    "Location-required guard missing"
  );
  assert.equal(
    editPreview.includes("currentPreviewSignature") ||
      editPreview.includes("hasFreshPreview"),
    true,
    "Fresh preview signature guard missing"
  );
  assert.equal(
    editPreview.includes("hasPreviewRegistryMismatch"),
    true,
    "Registry mismatch stale-preview guard missing"
  );
  assert.equal(
    editPreview.includes("previewFieldRegistryVersion"),
    true,
    "Execute payload missing previewFieldRegistryVersion"
  );
  assert.equal(
    editPreview.includes("previewOperatorRegistryVersion"),
    true,
    "Execute payload missing previewOperatorRegistryVersion"
  );
});

test("tailwind primitive import removed from app.css", () => {
  const appCss = read("web/frontend/app.css");
  assert.equal(
    /@import\s+["']tailwindcss["']/.test(appCss),
    false,
    "Tailwind primitive import should be removed"
  );
});

test("authenticated fetch bootstrap remains usable across mount/unmount lifecycle", () => {
  const firstFetch = async () => ({ ok: true });
  const secondFetch = async () => ({ ok: true });

  const cleanupFirst = bootstrapAuthenticatedFetch(firstFetch);
  assert.equal(getAuthenticatedFetch(), firstFetch);

  const cleanupSecond = bootstrapAuthenticatedFetch(secondFetch);
  assert.equal(getAuthenticatedFetch(), secondFetch);

  cleanupFirst();
  assert.equal(getAuthenticatedFetch(), secondFetch);

  cleanupSecond();
  assert.equal(getAuthenticatedFetch(), null);

  setAuthenticatedFetch(null);
});
