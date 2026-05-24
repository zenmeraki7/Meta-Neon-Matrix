import { prisma } from "../config/database.js";

async function main() {
  const shop = process.env.EXPLAIN_SHOP;
  const batch = process.env.EXPLAIN_BATCH;

  if (!process.env.DATABASE_URL || !shop || !batch) {
    console.log("Skipping explain: set DATABASE_URL, EXPLAIN_SHOP, EXPLAIN_BATCH");
    return;
  }

  const queries = [
    {
      name: "collection_join",
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT DISTINCT pc."productId"
        FROM "ProductCollection" pc
        JOIN "Collection" c
          ON c."shop" = pc."shop"
         AND c."mirrorBatchId" = pc."mirrorBatchId"
         AND c."shopifyId" = pc."collectionId"
        WHERE pc."shop" = $1
          AND pc."mirrorBatchId" = $2
          AND LOWER(COALESCE(c."title", '')) = LOWER($3)
      `,
      params: [shop, batch, "Summer Collection"],
    },
    {
      name: "metafield_product",
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT DISTINCT m."ownerId"
        FROM "MetafieldMirror" m
        WHERE m."shop" = $1
          AND m."mirrorBatchId" = $2
          AND m."ownerType" = 'PRODUCT'
          AND m."namespace" = $3
          AND m."key" = $4
          AND LOWER(COALESCE(m."valueText", '')) LIKE LOWER($5)
      `,
      params: [shop, batch, "custom", "material", "%cot%"],
    },
  ];

  for (const query of queries) {
    const rows = await prisma.$queryRawUnsafe(query.sql, ...query.params);
    console.log(`\n=== ${query.name} ===`);
    for (const row of rows) {
      console.log(row["QUERY PLAN"]);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });