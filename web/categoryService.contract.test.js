import test from "node:test";
import assert from "node:assert/strict";
import CategoryService from "./services/category/categoryService.js";

function createCategoryDb(seed = []) {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]));
  function filterRows(where = {}) {
    const search = String(where?.searchText?.contains || "").toLowerCase();
    return Array.from(rows.values()).filter((row) => {
      if (!search) return true;
      return String(row.searchText || "").toLowerCase().includes(search);
    });
  }
  const model = {
    rows,
    async count({ where }) {
      return filterRows(where).length;
    },
    async findMany({ where, orderBy, select }) {
      void orderBy;
      void select;
      return filterRows(where)
        .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id.localeCompare(b.id))
        .map(({ id, name, fullName }) => ({ id, name, fullName }));
    },
    async upsert({ where, create, update }) {
      const existing = rows.get(where.id);
      rows.set(where.id, existing ? { ...existing, ...update } : { ...create });
      return rows.get(where.id);
    },
  };
  return { shopifyTaxonomyCategory: model };
}

function createService({ db, cache = new Map(), shopifyPages = [] }) {
  const calls = {
    entitlement: 0,
    shopify: 0,
    cacheKeys: [],
  };
  const shopifyApi = {
    session: {
      getOfflineId(shop) {
        return `offline_${shop}`;
      },
    },
    config: {
      sessionStorage: {
        async loadSession(id) {
          return { shop: id.replace("offline_", "") };
        },
      },
    },
    clients: {
      Graphql: class {
        async query() {
          const page = shopifyPages[calls.shopify] || shopifyPages.at(-1);
          calls.shopify += 1;
          return page;
        }
      },
    },
  };

  const service = new CategoryService({
    db,
    shopifyApi,
    async getCache(key) {
      calls.cacheKeys.push(key);
      return cache.get(key);
    },
    async setCache(key, value) {
      cache.set(key, value);
    },
    async assertEntitlement() {
      calls.entitlement += 1;
    },
  });
  return { service, calls, cache };
}

test("category service serves taxonomy from mirror without live Shopify call", async () => {
  const db = createCategoryDb([
    {
      id: "gid://shopify/TaxonomyCategory/1",
      name: "Shirts",
      fullName: "Apparel > Shirts",
      searchText: "shirts apparel > shirts",
    },
    {
      id: "gid://shopify/TaxonomyCategory/2",
      name: "Shoes",
      fullName: "Apparel > Shoes",
      searchText: "shoes apparel > shoes",
    },
  ]);
  const { service, calls } = createService({ db });

  const result = await service.getAllCategories({
    shop: "s1",
    search: "apparel",
    limit: 1,
  });

  assert.equal(result.source, "MIRROR");
  assert.equal(result.categories.length, 1);
  assert.deepEqual(result.pageInfo, {
    hasNextPage: true,
    nextCursor: "1",
    totalCount: 2,
  });
  assert.equal(calls.shopify, 0);
  assert.equal(calls.entitlement, 0);
  assert.equal(calls.cacheKeys[0], "s1:taxonomyCategories:v1:apparel");
});

test("category service does not multiply cache keys by limit", async () => {
  const db = createCategoryDb([
    {
      id: "1",
      name: "Alpha",
      fullName: "Alpha",
      searchText: "alpha",
    },
  ]);
  const { service, calls } = createService({ db });

  await service.getAllCategories({ shop: "s1", search: "alpha", limit: 1 });
  await service.getAllCategories({ shop: "s1", search: "alpha", limit: 20 });

  assert.deepEqual(Array.from(new Set(calls.cacheKeys)), [
    "s1:taxonomyCategories:v1:alpha",
  ]);
});

test("category service rejects corrupt taxonomy cache", async () => {
  const db = createCategoryDb([
    {
      id: "1",
      name: "Alpha",
      fullName: "Alpha",
      searchText: "alpha",
    },
  ]);
  const cache = new Map([["s1:taxonomyCategories:v1:all", { stale: true }]]);
  const { service } = createService({ db, cache });

  await assert.rejects(
    () => service.getAllCategories({ shop: "s1" }),
    /CATEGORY_CACHE_CORRUPT/,
  );
});

test("category service refreshes taxonomy mirror once when mirror is empty", async () => {
  const db = createCategoryDb();
  const firstPage = {
    body: {
      data: {
        taxonomy: {
          categories: {
            edges: [
              {
                cursor: "c1",
                node: {
                  id: "gid://shopify/TaxonomyCategory/10",
                  name: "Bags",
                  fullName: "Accessories > Bags",
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: "c1" },
          },
        },
      },
    },
  };
  const { service, calls } = createService({ db, shopifyPages: [firstPage] });

  const result = await service.getAllCategories({ shop: "s1", limit: 10 });

  assert.equal(calls.entitlement, 1);
  assert.equal(calls.shopify, 1);
  assert.equal(result.source, "MIRROR");
  assert.equal(result.categories[0].fullName, "Accessories > Bags");
});
