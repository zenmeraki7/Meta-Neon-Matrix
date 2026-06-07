import test from "node:test";
import assert from "node:assert/strict";
import { languageSchema, supportedLanguages } from "./validations/storeAccessSchema.js";

test("language schema exports the supported language allowlist", () => {
  assert.ok(supportedLanguages.includes("en"));
  assert.ok(supportedLanguages.includes("ru"));
});

test("language schema rejects unknown fields explicitly", () => {
  const { error } = languageSchema.validate({
    language: "en",
    extra: true,
  });

  assert.match(error?.message || "", /extra/);
});

test("language schema keeps specific allowlist errors", () => {
  const { error } = languageSchema.validate({ language: "xx" });

  assert.match(error?.message || "", /Language must be one of:/);
});
