import test from "node:test";
import assert from "node:assert/strict";
import { createProductQueryController } from "./controllers/productQueryController.js";

function mockRes() {
  const headers = {};
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
    set(obj) {
      Object.assign(headers, obj);
    },
    getHeader(name) {
      return headers[name] || this[name];
    },
    setHeader(name, val) {
      headers[name] = val;
    },
    locals: {
      shopify: {
        session: {
          shop: "query-store.myshopify.com",
          id: "offline_query-store.myshopify.com",
        },
      },
    },
  };
  return { res, headers };
}

function mockReq(params = {}, query = {}, body = {}) {
  return {
    method: "GET",
    route: { path: "/api/products/get-all" },
    params,
    query,
    body,
    get() {
      return null;
    },
    headers: {},
  };
}

test("productQueryController factory passes complete command to getBulkEditStatus and applies private no-store headers", async () => {
  let statusCommandPassed = null;

  const controller = createProductQueryController({
    executeProductQuery: async () => {},
    getBulkEditStatus: async (cmd) => {
      statusCommandPassed = cmd;
      return {
        id: "hist_123",
        shop: cmd.shop,
        status: "completed",
        rootObjectCount: 10,
        totalItems: 10,
        duration: 120,
      };
    },
    getPreviewFilterRegistry: async () => {},
    getProductFilterValueOptions: async () => {},
    getProductTypeOptions: async () => {},
  });

  const req = mockReq({ id: "hist_123" });
  const { res, headers } = mockRes();

  await controller.checkEditStatus(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.rootObjectCount, 10);
  assert.equal(statusCommandPassed.shop, "query-store.myshopify.com");
  assert.equal(statusCommandPassed.historyId, "hist_123");
  assert.equal(headers["Cache-Control"], "private, no-store, max-age=0");
});

test("productQueryController returns tenant-safe 404 error response when edit history is unowned or missing", async () => {
  const controller = createProductQueryController({
    executeProductQuery: async () => {},
    getBulkEditStatus: async () => {
      const err = new Error("Requested edit history record was not found");
      err.code = "NOT_FOUND";
      throw err;
    },
    getPreviewFilterRegistry: async () => {},
    getProductFilterValueOptions: async () => {},
    getProductTypeOptions: async () => {},
  });

  const req = mockReq({ id: "unowned_hist_999" });
  const { res } = mockRes();

  await controller.checkEditStatus(req, res);

  assert.equal(res.statusCode, 404);
});
