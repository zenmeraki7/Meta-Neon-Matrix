import { prisma } from "../config/database.js";

export async function saveBeforeSnapshotOnce({
  shop,
  bulkApplyJobId,
  productId,
  beforeValues,
}: {
  shop: string;
  bulkApplyJobId: string;
  productId: string;
  beforeValues: unknown;
}) {
  await prisma.productApplySnapshot.upsert({
    where: {
      shop_bulkJobId_productId: {
        shop,
        bulkApplyJobId,
        productId,
      },
    },
    create: {
      shop,
      bulkApplyJobId,
      productId,
      beforeValues,
    },
    update: {},
  });
}
