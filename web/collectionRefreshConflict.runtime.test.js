import test from "node:test";
import assert from "node:assert/strict";
import { buildPublicApiErrorResponse } from "./utils/publicApiError.js";

function createRes(session = null) {
  return {
    statusCode: 200,
    body: null,
    locals: {
      shopify: {
        session,
      },
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("POST /refresh returns CONFLICT when a bulk operation is already running", async () => {
  const mockCollectionService = {
    async performCollectionRefresh() {
      const error = new Error("CONFLICT");
      error.code = "CONFLICT";
      throw error;
    },
  };

  const handler = async (req, res) => {
    try {
      const session = res.locals?.shopify?.session;
      if (!session?.shop) {
        const unauthenticated = new Error("Unauthenticated Shopify session");
        unauthenticated.code = "UNAUTHENTICATED";
        throw unauthenticated;
      }
      const idempotencyKey = req.get("Idempotency-Key")?.trim();
      if (!idempotencyKey) {
        const missing = new Error("Idempotency-Key header is required");
        missing.code = "IDEMPOTENCY_KEY_REQUIRED";
        throw missing;
      }
      await mockCollectionService.performCollectionRefresh({ shop: session.shop, idempotencyKey }, { session });
      return res.status(202).json({ success: true });
    } catch (error) {
      const { statusCode, body } = buildPublicApiErrorResponse(error, error.code || "INTERNAL_ERROR");
      return res.status(statusCode).json(body);
    }
  };

  const req = {
    get(name) {
      if (String(name).toLowerCase() === "idempotency-key") return "k-1";
      return null;
    },
  };
  const res = createRes({ shop: "shop-a.myshopify.com" });

  await handler(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.success, false);
  assert.equal(res.body?.code, "CONFLICT");
});
