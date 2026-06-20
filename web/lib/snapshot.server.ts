import { prisma } from "../config/database.js";

export async function saveBeforeSnapshotOnce({
  shop,
  bulkJobId,
  productId,
  before,
}: {
  shop: string;
  bulkJobId: string;
  productId: string;
  before: unknown;
}) {
  await prisma.productApplySnapshot.upsert({
    where: {
      shop_bulkJobId_productId: {
        shop,
        bulkJobId,
        productId,
      },
    },
    create: {
      shop,
      bulkJobId,
      productId,
      before,
    },
    update: {},
  });
}
