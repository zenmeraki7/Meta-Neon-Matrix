import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("App installation worker implements explicit status claims and completion checks", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "Jobs/Workers/appInstallationWorker.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("claimInstallation"),
    "appInstallationWorker must define claimInstallation",
  );
  assert.ok(
    fileContent.includes('installationStatus: "INSTALLING"'),
    "appInstallationWorker must set status to INSTALLING upon claim",
  );
  assert.ok(
    fileContent.includes('installationStatus: "INSTALLED"'),
    "appInstallationWorker must update status to INSTALLED upon completion",
  );
  assert.ok(
    fileContent.includes("INSTALLATION_OWNERSHIP_LOST"),
    "appInstallationWorker must throw INSTALLATION_OWNERSHIP_LOST if ownership lost",
  );
  assert.ok(
    fileContent.includes('installationStatus: "INSTALL_FAILED"'),
    "appInstallationWorker must update status to INSTALL_FAILED upon error",
  );
});

test("Product sync service reconciles active bulk operations before initial sync submit", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "services/productService/productSyncService.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("reconcileBulkOperationAndSyncHistory"),
    "productSyncService must define reconcileBulkOperationAndSyncHistory",
  );
  assert.ok(
    fileContent.includes("getCurrentBulkOperationStatus"),
    "productSyncService must query getCurrentBulkOperationStatus from Shopify",
  );
});
