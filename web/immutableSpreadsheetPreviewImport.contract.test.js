import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "crypto";
import {
  saveFile,
  verifyStreamSha256,
  canonicalizeMappings,
  openReadStream,
} from "./services/storage/immutableObjectStorage.js";
import ProductImportCommandService from "./services/productImport/ProductImportCommandService.js";

function createFakeImportDb() {
  const spreadsheetFiles = new Map();
  const editHistories = new Map();
  const idempotencyRecords = new Map();

  const dbClient = {
    store: {
      async findUnique() {
        return { shopUrl: "store.myshopify.com", plan: "PRO", status: "ACTIVE", subscriptionStatus: "ACTIVE", installationStatus: "INSTALLED" };
      },
    },
    subscription: {
      async findFirst() {
        return { id: "sub_1", shop: "store.myshopify.com", planKey: "PRO", status: "ACTIVE", statusNormalized: "ACTIVE" };
      },
    },
    spreadsheetFile: {
      async findFirst({ where }) {
        for (const file of spreadsheetFiles.values()) {
          if (where.id && file.id !== where.id) continue;
          if (where.shop && file.shop !== where.shop) continue;
          if (where.status && file.status !== where.status) continue;
          return file;
        }
        return null;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const [id, file] of spreadsheetFiles.entries()) {
          if (where.id && file.id !== where.id) continue;
          if (where.shop && file.shop !== where.shop) continue;
          spreadsheetFiles.set(id, { ...file, ...data });
          count++;
        }
        return { count };
      },
    },
    editHistory: {
      async create({ data }) {
        const id = `hist_${editHistories.size + 1}`;
        const record = { id, ...data };
        editHistories.set(id, record);
        return record;
      },
      async update({ where, data }) {
        const existing = editHistories.get(where.id);
        const updated = { ...existing, ...data };
        editHistories.set(where.id, updated);
        return updated;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const [id, hist] of editHistories.entries()) {
          if (where.id && hist.id !== where.id) continue;
          if (where.shop && hist.shop !== where.shop) continue;
          editHistories.set(id, { ...hist, ...data });
          count++;
        }
        return { count };
      },
    },
    idempotencyRecord: {
      async findUnique({ where }) {
        if (where.shop_scope_key) {
          const key = `${where.shop_scope_key.shop}:${where.shop_scope_key.scope}:${where.shop_scope_key.key}`;
          return idempotencyRecords.get(key) || null;
        }
        for (const rec of idempotencyRecords.values()) {
          if (where.id && rec.id === where.id) return rec;
        }
        return null;
      },
      async create({ data }) {
        const key = `${data.shop}:${data.scope}:${data.key}`;
        const record = { id: `idem_${idempotencyRecords.size + 1}`, ...data };
        idempotencyRecords.set(key, record);
        return record;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const [key, rec] of idempotencyRecords.entries()) {
          if (where.id && rec.id !== where.id) continue;
          if (where.shop && rec.shop !== where.shop) continue;
          if (where.ownerToken && rec.ownerToken !== where.ownerToken) continue;
          idempotencyRecords.set(key, { ...rec, ...data });
          count++;
        }
        return { count };
      },
    },
  };

  return { spreadsheetFiles, editHistories, dbClient };
}

test("immutableObjectStorage saveFile computes content SHA-256 and stores file at deterministic key", async () => {
  const tmpDir = path.join(process.cwd(), "uploads", "test_tmp");
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const testFile = path.join(tmpDir, "sample.csv");
  const content = "Title,Vendor,Price\nTest Product,Acme,19.99\n";
  await fs.promises.writeFile(testFile, content);

  const expectedHash = crypto.createHash("sha256").update(content).digest("hex");

  const saved = await saveFile({
    shop: "store.myshopify.com",
    file: { path: testFile, originalname: "sample.csv" },
  });

  assert.equal(saved.contentSha256, expectedHash);
  assert.equal(saved.storageKey, `imports/store.myshopify.com/${expectedHash}.csv`);
  assert.equal(Number(saved.sizeBytes), Buffer.byteLength(content));

  // Verify stream reading and sha256 checksum verification
  const readStream = openReadStream(saved.storageKey);
  const verified = await verifyStreamSha256(readStream, expectedHash);
  assert.equal(verified, true);

  // Mismatched hash verification must throw CSV_CHECKSUM_MISMATCH
  await assert.rejects(
    () => verifyStreamSha256(testFile, "0000000000000000000000000000000000000000000000000000000000000000"),
    (err) => {
      assert.equal(err.code, "CSV_CHECKSUM_MISMATCH");
      return true;
    },
  );
});

test("canonicalizeMappings returns deterministic sorted key-value mapping object", () => {
  const raw = { vendor: "vendor", title: "title", price: "variantPrice" };
  const canonical = canonicalizeMappings(raw);
  assert.deepEqual(Object.keys(canonical), ["price", "title", "vendor"]);
  assert.equal(canonical.title, "title");
});

test("schema.prisma defines SpreadsheetFile immutable storage fields and shop-scoped unique constraints", () => {
  const schema = fs.readFileSync(new URL("./prisma/schema.prisma", import.meta.url), "utf8");
  assert.ok(schema.includes("storageKey         String"), "storageKey missing");
  assert.ok(schema.includes('contentSha256      String    @default("") @map("checksum")'), "contentSha256 missing");
  assert.ok(schema.includes("sizeBytes          BigInt"), "sizeBytes missing");
  assert.ok(schema.includes("previewedAt        DateTime?"), "previewedAt missing");
  assert.ok(schema.includes("executionClaimedAt DateTime?"), "executionClaimedAt missing");
  assert.ok(schema.includes("@@unique([shop, id])"), "SpreadsheetFile @@unique([shop, id]) missing");
  assert.ok(schema.includes("@@unique([shop, contentSha256, id])"), "SpreadsheetFile @@unique([shop, contentSha256, id]) missing");
});

test("migration file contains SpreadsheetFile unique indexes and storage columns", () => {
  const migration = fs.readFileSync(
    new URL("./prisma/migrations/20260730140000_immutable_spreadsheet_file_correlation/migration.sql", import.meta.url),
    "utf8",
  );
  assert.ok(migration.includes('CREATE UNIQUE INDEX IF NOT EXISTS "SpreadsheetFile_shop_id_uq"'), "SpreadsheetFile_shop_id_uq index missing");
  assert.ok(migration.includes('CREATE UNIQUE INDEX IF NOT EXISTS "SpreadsheetFile_shop_checksum_id_uq"'), "SpreadsheetFile_shop_checksum_id_uq index missing");
  assert.ok(migration.includes('ALTER TABLE "SpreadsheetFile" ADD COLUMN IF NOT EXISTS "storageKey"'), "storageKey column missing");
  assert.ok(migration.includes('ALTER TABLE "SpreadsheetFile" ADD COLUMN IF NOT EXISTS "sizeBytes"'), "sizeBytes column missing");
});

test("productRoutes.js POST /csv/import removes uploadCsv.single('file') middleware", () => {
  const routesSrc = fs.readFileSync(new URL("./routes/productRoutes.js", import.meta.url), "utf8");
  const csvImportBlock = routesSrc.slice(routesSrc.indexOf('"/csv/import"'), routesSrc.indexOf('"/csv/preview"'));
  assert.ok(!csvImportBlock.includes('uploadCsv.single("file")'), "/csv/import must not include uploadCsv middleware");
});

test("ProductImportCommandService createImportCommand rejects non-existent preview uploadToken", async () => {
  const { dbClient } = createFakeImportDb();
  const service = new ProductImportCommandService(dbClient);
  await assert.rejects(
    () => service.createImportCommand({
      shop: "store.myshopify.com",
      uploadToken: "non_existent_token",
      columnMappings: { Title: "title" },
      idempotencyKey: "idem_key_1",
    }),
    (err) => {
      assert.equal(err.code, "PREVIEW_NOT_FOUND");
      return true;
    },
  );
});

test("ProductImportCommandService createImportCommand claims PREVIEW_READY file and marks EXECUTION_CLAIMED", async () => {
  const { spreadsheetFiles, editHistories, dbClient } = createFakeImportDb();
  spreadsheetFiles.set("token_101", {
    id: "token_101",
    shop: "store.myshopify.com",
    storageKey: "imports/store.myshopify.com/hash123.csv",
    contentSha256: "hash123",
    sizeBytes: 500n,
    status: "PREVIEW_READY",
    originalFilename: "products.csv",
  });

  const service = new ProductImportCommandService(dbClient);
  const result = await service.createImportCommand({
    shop: "store.myshopify.com",
    uploadToken: "token_101",
    columnMappings: { Title: "title", Vendor: "vendor" },
    subscription: { id: "sub_1", shop: "store.myshopify.com", planKey: "PRO", status: "ACTIVE", statusNormalized: "ACTIVE" },
    idempotencyKey: "idem_key_2",
  });

  assert.ok(result.operationId);
  assert.equal(result.importId, "token_101");
  assert.equal(result.status, "QUEUED");

  const fileDoc = spreadsheetFiles.get("token_101");
  assert.equal(fileDoc.status, "EXECUTION_CLAIMED");
  assert.equal(fileDoc.editHistoryId, result.operationId);
  assert.ok(fileDoc.executionClaimedAt instanceof Date);

  assert.equal(editHistories.size, 1);
  const history = editHistories.get(result.operationId);
  assert.equal(history.shop, "store.myshopify.com");
});
