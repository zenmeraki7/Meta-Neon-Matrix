CREATE TABLE IF NOT EXISTS "ShopifyTaxonomyCategory" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "searchText" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ShopifyTaxonomyCategory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ShopifyTaxonomyCategory_name_idx"
  ON "ShopifyTaxonomyCategory" ("name");

CREATE INDEX IF NOT EXISTS "ShopifyTaxonomyCategory_fullName_idx"
  ON "ShopifyTaxonomyCategory" ("fullName");
