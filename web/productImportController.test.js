import test from "node:test";
import assert from "node:assert/strict";
import {
  createProductImportController,
  removeUploadedFile,
} from "./controllers/productImportController.js";
import {
  toCsvPreviewAcceptedDto,
  toCsvPreviewPageDto,
  toProductImportAcceptedDto,
} from "./dtos/productImportDto.js";

function mockRes() {
  const res = {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    getHeader(name) {
      return this[name];
    },
    setHeader(name, val) {
      this[name] = val;
    },
    locals: {
      shopify: {
        session: {
          shop: "import-shop.myshopify.com",
          id: "offline_import-shop.myshopify.com",
        },
      },
    },
  };
  return res;
}

function mockReq(headers = {}, query = {}, body = {}, file = null) {
  return {
    method: "POST",
    route: { path: "/api/products/import" },
    query,
    body,
    file,
    get(headerName) {
      const lower = String(headerName).toLowerCase();
      return headers[lower] ?? headers[headerName] ?? null;
    },
    headers,
  };
}

test("productImportController factory supports dependency injection and passes complete command", async () => {
  let commandPassed = null;
  let fileRemoved = null;

  const controller = createProductImportController({
    productImportCommandService: {
      async createImportCommand(cmd) {
        commandPassed = cmd;
        return {
          operationId: "op_123",
          importId: "imp_456",
          status: "QUEUED",
          fileOwnershipTransferred: true,
          internalPath: "/secret/path.csv",
        };
      },
    },
    productImportPreviewService: {
      async createCsvPreview() {},
      async previewCsvPage() {},
    },
    removeUploadedFile: async (path) => {
      fileRemoved = path;
    },
  });

  const req = mockReq(
    { "idempotency-key": "import_key_123" },
    {},
    {},
    { path: "/tmp/upload.csv", originalname: "products.csv", size: 1024, mimetype: "text/csv" },
  );
  const res = mockRes();

  await controller.importCsvController(req, res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.operationId, "op_123");
  assert.equal(res.body.importId, "imp_456");
  assert.equal(res.body.status, "QUEUED");
  assert.equal(res.body.internalPath, undefined);
  assert.equal(commandPassed.shop, "import-shop.myshopify.com");
  assert.equal(commandPassed.idempotencyKey, "import_key_123");
  assert.equal(fileRemoved, null);
});

test("productImportController cleans up file when service throws BEFORE ownership transfer", async () => {
  let fileRemoved = null;

  const controller = createProductImportController({
    productImportCommandService: {
      async createImportCommand() {
        const err = new Error("Validation error prior to ownership transfer");
        err.code = "VALIDATION_FAILED";
        throw err;
      },
    },
    productImportPreviewService: {},
    removeUploadedFile: async (path) => {
      fileRemoved = path;
    },
  });

  const req = mockReq(
    { "idempotency-key": "import_key_456" },
    {},
    {},
    { path: "/tmp/failed_upload.csv", mimetype: "text/csv" },
  );
  const res = mockRes();

  await controller.importCsvController(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(fileRemoved, "/tmp/failed_upload.csv");
});

test("toProductImportAcceptedDto redacts internal fields", () => {
  const result = {
    operationId: "op_999",
    importId: "imp_999",
    status: "QUEUED",
    internalDownloadUrl: "http://storage.internal/file.csv",
    outboxEventId: "outbox_123",
  };
  const dto = toProductImportAcceptedDto(result);
  assert.equal(dto.operationId, "op_999");
  assert.equal(dto.importId, "imp_999");
  assert.equal(dto.status, "QUEUED");
  assert.equal(dto.internalDownloadUrl, undefined);
  assert.equal(dto.outboxEventId, undefined);
});

test("toCsvPreviewAcceptedDto redacts internal fields", () => {
  const result = {
    uploadToken: "token_abc123",
    status: "QUEUED",
    dbId: "db_456",
  };
  const dto = toCsvPreviewAcceptedDto(result);
  assert.equal(dto.uploadToken, "token_abc123");
  assert.equal(dto.status, "QUEUED");
  assert.equal(dto.dbId, undefined);
});

test("toCsvPreviewPageDto formats page items correctly", () => {
  const result = {
    items: [{ title: "Item 1" }],
    headers: ["title"],
    pageInfo: { hasNextPage: true, hasPreviousPage: false, nextCursor: "cur_2" },
    totalCount: 1,
    internalScanPath: "/scan/file.csv",
  };
  const dto = toCsvPreviewPageDto(result);
  assert.equal(dto.items.length, 1);
  assert.equal(dto.headers[0], "title");
  assert.equal(dto.pageInfo.hasNextPage, true);
  assert.equal(dto.pageInfo.nextCursor, "cur_2");
  assert.equal(dto.totalCount, 1);
  assert.equal(dto.internalScanPath, undefined);
});

test("removeUploadedFile handles ENOENT silently without throwing", async () => {
  await assert.doesNotReject(async () => {
    await removeUploadedFile("/non/existent/path/file.csv");
  });
});
