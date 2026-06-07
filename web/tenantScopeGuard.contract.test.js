import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTenantScopedPrismaArgs,
  assertTenantScopedRawPrismaArgs,
} from "./config/tenantScopeGuard.js";

test("tenant guard rejects missing tenant scope in where queries", () => {
  assert.throws(
    () => assertTenantScopedPrismaArgs("Product", "findMany", { where: { id: "p1" } }),
    /TENANT_SCOPE_REQUIRED:Product\.findMany:where:shop/,
  );

  assert.throws(
    () => assertTenantScopedPrismaArgs("EditHistory", "updateMany", { where: { id: "h1" } }),
    /TENANT_SCOPE_REQUIRED:EditHistory\.updateMany:where:shop/,
  );
});

test("tenant guard rejects optional or broad tenant predicates", () => {
  assert.throws(
    () => assertTenantScopedPrismaArgs("Product", "findMany", { where: { id: "p1", shop: undefined } }),
    /TENANT_SCOPE_REQUIRED:Product\.findMany:where:shop/,
  );

  assert.throws(
    () => assertTenantScopedPrismaArgs("Product", "findMany", { where: { shop: { in: ["a", "b"] } } }),
    /TENANT_SCOPE_REQUIRED:Product\.findMany:where:shop/,
  );
});

test("tenant guard rejects tenant scope buried in logical or relation branches", () => {
  assert.throws(
    () =>
      assertTenantScopedPrismaArgs("Product", "findMany", {
        where: { OR: [{ shop: "shop-a.myshopify.com" }, { id: "p1" }] },
      }),
    /TENANT_SCOPE_REQUIRED:Product\.findMany:where:shop/,
  );

  assert.throws(
    () =>
      assertTenantScopedPrismaArgs("Product", "findMany", {
        where: { AND: [{ shop: "shop-a.myshopify.com" }, { id: "p1" }] },
      }),
    /TENANT_SCOPE_REQUIRED:Product\.findMany:where:shop/,
  );

  assert.throws(
    () =>
      assertTenantScopedPrismaArgs("AutomaticProductRuleRun", "findFirst", {
        where: {
          id: "run1",
          automaticProductRule: { shop: "shop-a.myshopify.com" },
        },
      }),
    /TENANT_SCOPE_REQUIRED:AutomaticProductRuleRun\.findFirst:where:shop/,
  );
});

test("tenant guard accepts concrete tenant predicates", () => {
  assert.doesNotThrow(() =>
    assertTenantScopedPrismaArgs("Product", "findMany", {
      where: { id: "p1", shop: "shop-a.myshopify.com" },
    }),
  );

  assert.doesNotThrow(() =>
    assertTenantScopedPrismaArgs("OperationLease", "findUnique", {
      where: {
        shop_namespace_resourceId: {
          shop: "shop-a.myshopify.com",
          namespace: "BULK_EDIT",
          resourceId: "h1",
        },
      },
    }),
  );
});

test("tenant guard enforces tenant data on writes", () => {
  assert.throws(
    () => assertTenantScopedPrismaArgs("ChangeRecord", "create", { data: { editHistoryId: "h1" } }),
    /TENANT_SCOPE_REQUIRED:ChangeRecord\.create:data:shop/,
  );

  assert.doesNotThrow(() =>
    assertTenantScopedPrismaArgs("ChangeRecord", "create", {
      data: { shop: "shop-a.myshopify.com", editHistoryId: "h1" },
    }),
  );
});

test("tenant guard blocks raw SQL against tenant tables without a shop predicate", () => {
  assert.throws(
    () => assertTenantScopedRawPrismaArgs("$queryRawUnsafe", [
      'SELECT * FROM "EditHistory" WHERE "status" = $1',
    ]),
    /TENANT_SCOPE_REQUIRED:RAW\.\$queryRawUnsafe:shop_predicate/,
  );
  assert.doesNotThrow(() =>
    assertTenantScopedRawPrismaArgs("$queryRawUnsafe", [
      'SELECT * FROM "EditHistory" WHERE "shop" = $1 AND "status" = $2',
    ]));
});

test("tenant guard allows non-data raw statements", () => {
  assert.doesNotThrow(() =>
    assertTenantScopedRawPrismaArgs("$executeRaw", {
      strings: ["SET LOCAL statement_timeout = ", ""],
    }));
});
