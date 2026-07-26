import test from "node:test";
import assert from "node:assert/strict";
import { buildActorContext } from "./utils/operationContextUtils.js";
import { normalizeShopDomain } from "./utils/shopDomainUtils.js";

test("buildActorContext canonical shop output ignores client body/query/headers actor overrides", () => {
  const req = {
    body: { actor: { id: "hacker_123", email: "evil@hacker.com", type: "SUPER_ADMIN" } },
    query: { actorId: "hacker_456" },
    headers: {
      "x-actor-id": "header_hacker",
      "x-actor-email": "header@hacker.com",
    },
  };

  const session = {
    shop: "STORE-SHOPIFY.MYSHOPIFY.COM",
    id: "offline_store-shopify.myshopify.com",
  };

  const actor = buildActorContext({
    req,
    session,
    shop: normalizeShopDomain(session.shop),
  });

  assert.equal(actor.shop, "store-shopify.myshopify.com");
  assert.equal(actor.actorType, "MERCHANT_ADMIN");
  assert.equal(actor.actorId, "offline_store-shopify.myshopify.com");
  assert.notEqual(actor.actorId, "hacker_123");
  assert.notEqual(actor.actorEmail, "evil@hacker.com");
});

test("buildActorContext reads online access token session user identity safely", () => {
  const session = {
    shop: "merchant.myshopify.com",
    id: "online_token_123",
    associated_user: {
      id: 987654321,
      first_name: "John",
      last_name: "Doe",
      email: "merchant@store.com",
    },
  };

  const actor = buildActorContext({
    session,
    shop: "merchant.myshopify.com",
  });

  assert.equal(actor.actorId, "987654321");
  assert.equal(actor.actorEmail, "merchant@store.com");
  assert.equal(actor.actorDisplayName, "John Doe");
  assert.equal(actor.actorType, "MERCHANT_ADMIN");
});
