import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildCreateProductCodeSnippetCommand,
  buildListProductCodeSnippetsCommand,
  buildPreviewProductCodeSnippetCommand,
  buildSearchSnippetPreviewProductsCommand,
} from "./normalizers/productCodeSnippetCommandNormalizer.js";

const context = {
  shop: "example.myshopify.com",
  actor: {
    actorType: "staff",
    actorId: "staff-1",
  },
};

const read = (file) => fs.readFileSync(path.resolve(file), "utf8");

test("product code snippet normalizer rejects null bytes in code", () => {
  assert.throws(
    () => buildCreateProductCodeSnippetCommand({
      ...context,
      body: {
        title: "Snippet",
        code: "set title\u0000bad",
      },
    }),
    /null bytes not allowed/,
  );
});

test("product code snippet normalizer rejects poison keys in snippet bodies", () => {
  const body = JSON.parse('{"title":"Snippet","code":"set title","constructor":{}}');

  assert.throws(
    () => buildCreateProductCodeSnippetCommand({ ...context, body }),
    /unsafe key/,
  );
});

test("product code snippet list command normalizes bounded limit and cursor", () => {
  const command = buildListProductCodeSnippetsCommand({
    ...context,
    query: {
      search: "  Title  ",
      status: "active",
      limit: "75",
      cursor: "snippet_123",
    },
  });

  assert.deepEqual(command.query, {
    search: "Title",
    status: "ACTIVE",
    limit: 75,
    cursor: "snippet_123",
  });
  assert.equal(Object.isFrozen(command.query), true);
  assert.throws(
    () => buildListProductCodeSnippetsCommand({ ...context, query: { limit: "101" } }),
    /Invalid limit: must be 1-100/,
  );
});

test("snippet preview product id must be a Shopify product gid or numeric id", () => {
  assert.equal(
    buildPreviewProductCodeSnippetCommand({
      ...context,
      params: { id: "snippet_1" },
      body: { productId: "gid://shopify/Product/1234567890" },
    }).productId,
    "gid://shopify/Product/1234567890",
  );

  assert.equal(
    buildPreviewProductCodeSnippetCommand({
      ...context,
      params: { id: "snippet_1" },
      body: { productId: "1234567890" },
    }).productId,
    "1234567890",
  );

  assert.throws(
    () => buildPreviewProductCodeSnippetCommand({
      ...context,
      params: { id: "snippet_1" },
      body: { productId: "not-a-product" },
    }),
    /Invalid productId/,
  );
});

test("snippet search preview keeps a lower search-specific limit", () => {
  assert.equal(
    buildSearchSnippetPreviewProductsCommand({ ...context, query: { limit: "25" } }).limit,
    25,
  );
  assert.throws(
    () => buildSearchSnippetPreviewProductsCommand({ ...context, query: { limit: "26" } }),
    /Invalid limit: must be 1-25/,
  );
});

test("snippet list service and repository consume bounded pagination fields", () => {
  const service = read("web/services/productCodeSnippetService.js");
  const repository = read("web/repositories/productCodeSnippetRepository.js");

  assert.ok(service.includes("limit: query.limit"));
  assert.ok(service.includes("cursor: query.cursor"));
  assert.ok(repository.includes("take: Math.min(Math.max(Number(limit) || 20, 1), 100)"));
  assert.ok(repository.includes("cursor: { id: cursor }, skip: 1"));
});
