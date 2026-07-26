import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), "web", relativePath), "utf8");

function model(schema, name) {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] || "";
}

test("Store is the only tenant root and stores no plaintext token", () => {
  const schema = read("prisma/schema.prisma");
  const store = model(schema, "Store");

  assert.doesNotMatch(schema, /model LegacyShop \{/);
  assert.match(store, /accessTokenEncrypted\s+String\?/);
  assert.doesNotMatch(store, /\n\s+accessToken\s+String/);
});

test("legacy lifecycle booleans are removed from authoritative models", () => {
  const schema = read("prisma/schema.prisma");
  assert.doesNotMatch(model(schema, "Store"), /legacyIsUninstalled/);
  assert.doesNotMatch(model(schema, "AutomaticProductRule"), /legacyIsDeleted/);
});

test("retirement migration fails closed before dropping compatibility storage", () => {
  const migration = read(
    "prisma/migrations/20260726101000_retire_legacy_tenant_token_and_lifecycle/migration.sql",
  );

  const guard = migration.indexOf("Store contains plaintext-only access tokens");
  const tokenDrop = migration.indexOf('DROP COLUMN IF EXISTS "accessToken"');
  assert.ok(guard >= 0 && tokenDrop > guard);
  assert.match(migration, /confrelid = to_regclass\('public\.shops'\)/);
  assert.match(migration, /DROP TABLE IF EXISTS "shops"/);
});

test("token writes fail closed when encryption is unavailable", () => {
  const crypto = read("utils/tokenCrypto.js");
  const session = read("utils/sessionHandler.js");

  assert.match(crypto, /throw new Error\("ACCESS_TOKEN_ENCRYPTION_REQUIRED"\)/);
  assert.doesNotMatch(crypto, /accessToken:\s*accessToken \|\| null/);
  assert.doesNotMatch(session, /store\?\.accessToken\b/);
});
