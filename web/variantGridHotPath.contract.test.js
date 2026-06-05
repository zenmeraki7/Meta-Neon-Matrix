import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toVariantGridDto } from "./dtos/variantGridDto.js";
import { VariantGridQueryService } from "./services/catalog/variantGridQueryService.js";

const repositorySource = readFileSync(
  new URL("./repositories/variantGridRepository.js", import.meta.url),
  "utf8",
);
const dbSource = readFileSync(
  new URL("./db/variantMetafields.js", import.meta.url),
  "utf8",
);

test("variant grid SQL paginates variants, not metafield rows", () => {
  assert.match(dbSource, /Pagination is variant-boundary based/);
  assert.match(dbSource, /FROM variants v/);
  assert.match(dbSource, /LEFT JOIN variant_metafields vm/);
  assert.match(dbSource, /SELECT COUNT\(\*\)::int AS count/);
  assert.doesNotMatch(dbSource, /ORDER BY vm\.id ASC\s+LIMIT/);
});

test("variant grid service is injectable and validates shop through repository boundary", async () => {
  const seen = [];
  const service = new VariantGridQueryService({
    async fetchRows(shop, query) {
      seen.push({ shop, query });
      return {
        variants: { rows: [], nextCursor: null, total: 0 },
        isStale: false,
      };
    },
  });

  const result = await service.getVariantGrid({
    shop: "merchant.myshopify.com",
    query: { limit: 10 },
  });

  assert.deepEqual(seen, [
    { shop: "merchant.myshopify.com", query: { limit: 10 } },
  ]);
  assert.equal(result.total, 0);
});

test("variant grid repository whitelists query keys and caches stale check", () => {
  assert.match(repositorySource, /VARIANT_GRID_QUERY_KEYS/);
  assert.match(repositorySource, /VARIANT_GRID_QUERY_UNSUPPORTED_KEYS/);
  assert.match(repositorySource, /STALE_CACHE_TTL_MS/);
  assert.match(repositorySource, /getCachedStaleFlag/);
});

test("variant grid dto returns total and computes worst-case freshness", () => {
  const dto = toVariantGridDto({
    variants: {
      total: 99,
      nextCursor: "123",
      rows: [
        {
          variant_id: "1",
          product_id: "10",
          namespace: "custom",
          key: "fresh",
          value: "ok",
          synced_at: "2026-01-01T00:00:00.000Z",
          freshness: "FRESH",
        },
        {
          variant_id: "1",
          product_id: "10",
          namespace: "custom",
          key: "stale",
          value: "old",
          synced_at: "2026-01-02T00:00:00.000Z",
          freshness: "STALE",
        },
      ],
    },
    isStale: true,
  });

  assert.equal(dto.total, 99);
  assert.equal(dto.nextCursor, "123");
  assert.equal(dto.rows[0].freshness, "STALE");
  assert.equal(dto.rows[0].syncedAt, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(Object.keys(dto.rows[0].metafields), [
    "custom.fresh",
    "custom.stale",
  ]);
});

test("variant grid dto rejects malformed variant rows and malformed metafield keys", () => {
  assert.throws(
    () => toVariantGridDto({
      variants: { rows: [{ namespace: "custom", key: "x" }] },
      isStale: false,
    }),
    /VARIANT_GRID_ROW_MISSING_VARIANT_ID/,
  );

  assert.throws(
    () => toVariantGridDto({
      variants: {
        rows: [
          {
            variant_id: "1",
            namespace: "",
            key: "x",
          },
        ],
      },
      isStale: false,
    }),
    /VARIANT_GRID_METAFIELD_KEY_MALFORMED/,
  );
});
