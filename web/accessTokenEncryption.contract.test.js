import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

const schema = read("web/prisma/schema.prisma");
const tokenCrypto = read("web/utils/tokenCrypto.js");
const sessionHandler = read("web/utils/sessionHandler.js");

test("Store access tokens are encrypted-only in schema and runtime writes", () => {
  const storeModel = schema.slice(
    schema.indexOf("model Store {"),
    schema.indexOf("model Subscription {"),
  );
  assert.doesNotMatch(storeModel, /\baccessToken\s+String\?/);
  assert.match(storeModel, /\baccessTokenEncrypted\s+String\?/);
  assert.match(storeModel, /\baccessTokenKeyVersion\s+String\?/);

  assert.match(tokenCrypto, /throw new Error\("ACCESS_TOKEN_ENCRYPTION_REQUIRED"\)/);
  assert.doesNotMatch(tokenCrypto, /accessToken:\s*accessToken/);
  assert.doesNotMatch(sessionHandler, /store\?\.accessToken(?!Encrypted|KeyVersion)/);
  assert.match(sessionHandler, /Encrypted token missing or invalid/);
});
