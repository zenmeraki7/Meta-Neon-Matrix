-- DropForeignKey
ALTER TABLE "Variant" DROP CONSTRAINT "Variant_shop_productId_mirrorBatchId_fkey";

-- DropPrimaryKey
ALTER TABLE "Product" DROP CONSTRAINT "Product_pkey";

-- DropPrimaryKey
ALTER TABLE "Variant" DROP CONSTRAINT "Variant_pkey";

-- CreateIndex
CREATE UNIQUE INDEX "Product_shop_id_mirrorBatchId_key" ON "Product"("shop", "id", "mirrorBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_shop_id_mirrorBatchId_key" ON "Variant"("shop", "id", "mirrorBatchId");

-- AddPrimaryKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_pkey" PRIMARY KEY ("shop", "id");

-- AddPrimaryKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_pkey" PRIMARY KEY ("shop", "id");

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_shop_productId_fkey" FOREIGN KEY ("shop", "productId") REFERENCES "Product"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
