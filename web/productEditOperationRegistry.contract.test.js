import test from "node:test";
import assert from "node:assert/strict";
import {
  ProductEditOperationRegistry,
  assertValidOperationKey,
  resolveProductEditOperation,
} from "./services/bulkEdit/planner/productEditOperationRegistry.js";

const { PRODUCT_EDIT_OPERATIONS } = ProductEditOperationRegistry;

test("registry rejects ambiguous multi-category field resolution", () => {
  assert.throws(
    () => resolveProductEditOperation({
      fieldsBeingEdited: ["metafields", "inventory"],
    }),
    (error) => {
      assert.equal(error.code, "AMBIGUOUS_PRODUCT_EDIT_OPERATION");
      assert.deepEqual(error.operationKeys, ["METAFIELD_SET", "INVENTORY_SET"]);
      return true;
    },
  );

  assert.throws(
    () => resolveProductEditOperation({
      fieldsBeingEdited: ["title", "price"],
    }),
    /AMBIGUOUS_PRODUCT_EDIT_OPERATION:TITLE_SET,VARIANT_PRICE_SET/,
  );
});

test("registry uses correct destructive and collection operation metadata", () => {
  assert.equal(PRODUCT_EDIT_OPERATIONS.PRODUCT_DELETE.mutation, "productDelete");
  assert.deepEqual(
    PRODUCT_EDIT_OPERATIONS.COLLECTION_ADD.requiredScopes,
    ["write_collections"],
  );
  assert.deepEqual(
    PRODUCT_EDIT_OPERATIONS.COLLECTION_REMOVE.requiredScopes,
    ["write_collections"],
  );
});

test("registry resolves inventory adjustment separately from absolute inventory set", () => {
  assert.equal(
    resolveProductEditOperation({
      mutationIntent: { mutationType: "INVENTORY_ADJUST" },
    }),
    "INVENTORY_ADJUST",
  );
  assert.equal(
    PRODUCT_EDIT_OPERATIONS.INVENTORY_ADJUST.mutation,
    "inventoryAdjustQuantities",
  );
});

test("registry does not treat numbered option fields as current variant option operation keys", () => {
  assert.equal(
    resolveProductEditOperation({
      fieldsBeingEdited: ["optionValues"],
    }),
    "VARIANT_GENERIC_SET",
  );
  assert.equal(
    resolveProductEditOperation({
      fieldsBeingEdited: ["option1Values"],
    }),
    "PRODUCT_GENERIC_SET",
  );
});

test("registry validates operation definition completeness", () => {
  for (const key of Object.keys(PRODUCT_EDIT_OPERATIONS)) {
    assert.equal(assertValidOperationKey(key), key);
    const operationDef = PRODUCT_EDIT_OPERATIONS[key];
    assert.equal(typeof operationDef.target, "string");
    assert.equal(typeof operationDef.mutation, "string");
    assert.equal(typeof operationDef.apiStrategy, "string");
    assert.equal(typeof operationDef.executionPath, "string");
    assert.ok(Array.isArray(operationDef.requiredScopes));
    assert.ok(operationDef.requiredScopes.length > 0);
  }
});

test("media registry documents no-undo no-snapshot recovery expectation", () => {
  assert.equal(PRODUCT_EDIT_OPERATIONS.MEDIA_SET.undoable, false);
  assert.equal(PRODUCT_EDIT_OPERATIONS.MEDIA_SET.requiresBeforeSnapshot, false);
  assert.match(
    PRODUCT_EDIT_OPERATIONS.MEDIA_SET.recoveryExpectation,
    /MEDIA_OPERATIONS_REQUIRE_POST_WRITE_VERIFICATION/,
  );
});
