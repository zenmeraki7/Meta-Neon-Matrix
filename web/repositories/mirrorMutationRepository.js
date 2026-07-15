import { db } from "./repositoryDb.js";

export async function applyProductUpsertMutation({
  shop,
  productId,
  mirrorBatchId,
  mutationType,
  productData,
  variants,
  sourceEventAt,
}) {
  return db.$transaction(async (tx) => {
    const journal = await tx.mirrorMutationJournal.create({
      data: {
        shop,
        entityType: "PRODUCT",
        entityId: productId,
        productId,
        mutationType,
        payload: {
          productData,
          variants,
          mirrorBatchId,
        },
        sourceEventAt,
      },
      select: { sequence: true },
    });

    await tx.productTombstone.deleteMany({ where: { shop, productId } });

    await tx.product.upsert({
      where: {
        shop_id_mirrorBatchId: { shop, id: productId, mirrorBatchId },
      },
      create: { shop, id: productId, mirrorBatchId, ...productData },
      update: { ...productData },
    });

    if (Array.isArray(variants)) {
      const incomingIds = variants.map((item) => item.id).filter(Boolean);
      for (const variant of variants) {
        await tx.variant.upsert({
          where: {
            shop_id_mirrorBatchId: {
              shop,
              id: variant.id,
              mirrorBatchId,
            },
          },
          create: {
            shop,
            id: variant.id,
            productId,
            mirrorBatchId,
            title: variant.title ?? null,
            sku: variant.sku ?? null,
            barcode: variant.barcode ?? null,
            price: variant.price ?? null,
            compareAtPrice: variant.compareAtPrice ?? null,
            inventoryQuantity: variant.inventoryQuantity ?? null,
            inventoryPolicy: variant.inventoryPolicy ?? null,
            taxable: variant.taxable ?? null,
            taxCode: variant.taxCode ?? null,
            position: variant.position ?? null,
            selectedOptionsJson: variant.selectedOptionsJson ?? null,
            option1Value: variant.selectedOptionsJson?.[0]?.value ?? null,
            option2Value: variant.selectedOptionsJson?.[1]?.value ?? null,
            option3Value: variant.selectedOptionsJson?.[2]?.value ?? null,
          },
          update: {
            productId,
            title: variant.title ?? null,
            sku: variant.sku ?? null,
            barcode: variant.barcode ?? null,
            price: variant.price ?? null,
            compareAtPrice: variant.compareAtPrice ?? null,
            inventoryQuantity: variant.inventoryQuantity ?? null,
            inventoryPolicy: variant.inventoryPolicy ?? null,
            taxable: variant.taxable ?? null,
            taxCode: variant.taxCode ?? null,
            position: variant.position ?? null,
            selectedOptionsJson: variant.selectedOptionsJson ?? null,
            option1Value: variant.selectedOptionsJson?.[0]?.value ?? null,
            option2Value: variant.selectedOptionsJson?.[1]?.value ?? null,
            option3Value: variant.selectedOptionsJson?.[2]?.value ?? null,
          },
        });
      }

      await tx.variant.deleteMany({
        where: {
          shop,
          productId,
          mirrorBatchId,
          ...(incomingIds.length ? { id: { notIn: incomingIds } } : {}),
        },
      });
    }

    await tx.mirrorReconcileSignal.updateMany({
      where: { shop, entityType: "product", entityId: productId },
      data: { mutationSequence: journal.sequence, status: "pending", updatedAt: new Date() },
    });

    return journal;
  }, { isolationLevel: "Serializable", maxWait: 10000, timeout: 20000 });
}
