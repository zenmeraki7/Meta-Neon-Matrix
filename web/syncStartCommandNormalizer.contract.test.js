import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSyncStartCommand } from "./normalizers/syncStartCommandNormalizer.js";

const session = {
  shop: "test-shop.myshopify.com",
  accessToken: "shpat_valid_token",
  extra: { shouldNotLeak: true },
};

test("sync start command extracts only validated session fields", () => {
  const command = normalizeSyncStartCommand({
    headers: { "idempotency-key": "sync-start-key-0001" },
    query: { force: "yes" },
  }, session);

  assert.equal(command.shop, "test-shop.myshopify.com");
  assert.equal(command.accessToken, "shpat_valid_token");
  assert.equal(command.force, true);
  assert.equal(command.idempotencyKey, "sync-start-key-0001");
  assert.equal("session" in command, false);
  assert.equal("extra" in command, false);
  assert.equal(Object.isFrozen(command), true);
});

test("sync start command requires access token and idempotency key", () => {
  assert.throws(
    () => normalizeSyncStartCommand({ headers: {} }, session),
    /Validation failed/,
  );

  assert.throws(
    () => normalizeSyncStartCommand({
      headers: { "idempotency-key": "sync-start-key-0001" },
    }, { shop: "test-shop.myshopify.com" }),
    /Session missing access token/,
  );
});

test("sync start command still supports case-insensitive idempotency header", () => {
  const command = normalizeSyncStartCommand({
    headers: { "Idempotency-Key": "sync-start-key-0002" },
    body: { force: "1" },
  }, session);

  assert.equal(command.idempotencyKey, "sync-start-key-0002");
  assert.equal(command.force, true);
});
