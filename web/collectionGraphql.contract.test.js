import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const collectionGraphqlSource = fs.readFileSync("web/graphql/collection.js", "utf8");
const collectionServiceSource = fs.readFileSync(
  "web/services/collectionService/CollectionService.js",
  "utf8",
);

test("collection bulk operation is named as a mutation", () => {
  assert.ok(
    collectionGraphqlSource.includes("StartCollectionBulkSyncMutation"),
    "collection bulk operation must use mutation naming",
  );
  assert.equal(
    collectionGraphqlSource.includes("StartCollectionBulkQuery"),
    false,
    "misleading StartCollectionBulkQuery export must not exist",
  );
  assert.ok(
    collectionServiceSource.includes("StartCollectionBulkSyncMutation"),
    "CollectionService must import the mutation by its mutation name",
  );
});

test("collection queries use a reusable core fragment", () => {
  assert.ok(collectionGraphqlSource.includes("fragment CollectionCore on Collection"));
  assert.ok(collectionGraphqlSource.includes("...CollectionCore"));
});

test("GetCollections exposes cursor pagination fields", () => {
  assert.ok(collectionGraphqlSource.includes("$after: String"));
  assert.ok(collectionGraphqlSource.includes("after: $after"));
  assert.ok(collectionGraphqlSource.includes("cursor"));
  assert.ok(collectionGraphqlSource.includes("pageInfo"));
  assert.ok(collectionGraphqlSource.includes("hasNextPage"));
  assert.ok(collectionGraphqlSource.includes("endCursor"));
});

test("collection bulk operation response includes progress fields and user errors", () => {
  assert.ok(collectionGraphqlSource.includes("objectCount"));
  assert.ok(collectionGraphqlSource.includes("fileSize"));
  assert.ok(collectionGraphqlSource.includes("userErrors"));
  assert.ok(collectionServiceSource.includes("bulkOperationRunQuery?.userErrors"));
});

test("CollectionService uses extracted collection GraphQL definitions", () => {
  assert.ok(collectionServiceSource.includes("../../graphql/collection.js"));
  assert.equal(
    /const\s+BULK_OPERATION_MUTATION\s*=/.test(collectionServiceSource),
    false,
    "CollectionService must not keep an inline duplicate bulk operation",
  );
});
