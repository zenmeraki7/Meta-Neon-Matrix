import test from "node:test";
import assert from "node:assert/strict";

test("redactSensitive redacts token-like fields", async () => {
  const { redactSensitive } = await import("./utils/redactionUtils.js");
  const input = {
    accessToken: "shpat_1234567890",
    nested: { authorization: "Bearer abcdefghijk" },
    ok: "value",
  };
  const output = redactSensitive(input);
  assert.notEqual(output.accessToken, input.accessToken);
  assert.notEqual(output.nested.authorization, input.nested.authorization);
  assert.equal(output.ok, "value");
});

test("encrypt/decrypt roundtrip works when key configured", async () => {
  process.env.ACCESS_TOKEN_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ACCESS_TOKEN_KEY_VERSION = "vtest";

  const { encryptAccessToken, decryptAccessToken } = await import(
    `./utils/tokenCrypto.js?cacheBust=${Date.now()}`
  );

  const token = "shpat_live_token_value";
  const encrypted = encryptAccessToken(token);
  assert.ok(encrypted?.startsWith("vtest:"));
  const decrypted = decryptAccessToken(encrypted);
  assert.equal(decrypted, token);
});
