import { db } from "./repositoryDb.js";

export async function applyProductUpsertMutation({
  shop,
  productId,
  mirrorBatchId,
  mutationType,
  productData,
  variants,
  sourceEventOccurredAt,
  webhookDeliveryId = null,
  dbClient = null,
}) {
  const client = dbClient || db;
  return client.$transaction(async (tx) => {
    const current = typeof tx.$queryRaw === "function"
      ? (await tx.$queryRaw`
          SELECT "lastSourceEventAt" FROM "Product"
          WHERE "shop" = ${shop} AND "id" = ${productId} AND "mirrorBatchId" = ${mirrorBatchId}
          FOR UPDATE
        `)[0]
      : null;
    if (webhookDeliveryId) {
      const deliveryUpdated = await tx.webhookDelivery.updateMany({
        where: {
          id: webhookDeliveryId,
          shop,
          statusNormalized: { in: ["RECEIVED", "QUEUED"] },
        },
        data: {
          status: "PROCESSED",
          statusNormalized: "PROCESSED",
          processedAt: new Date(),
          lastError: null,
        },
      });

      if (deliveryUpdated.count !== 1) {
        const error = new Error("WEBHOOK_DELIVERY_COMPLETION_REJECTED");
        error.code = "WEBHOOK_DELIVERY_COMPLETION_REJECTED";
        throw error;
      }
    }

    if (current?.lastSourceEventAt && sourceEventOccurredAt && new Date(current.lastSourceEventAt) > new Date(sourceEventOccurredAt)) {
      return { sequence: null, skipped: true, reason: "STALE_SOURCE_EVENT" };
    }

    const journal = await tx.mirrorMutationJournal.create({
      data: {
        shop,
        entityType: "PRODUCT",
        entityId: productId,
        productId,
        webhookDeliveryId: webhookDeliveryId || null,
        mutationType,
        payload: {
          productData,
          variants,
          mirrorBatchId,
        },
        sourceEventOccurredAt,
      },
      select: { sequence: true },
    });

    await tx.productTombstone.deleteMany({ where: { shop, productId } });

    await tx.product.upsert({
      where: {
        shop_id_mirrorBatchId: { shop, id: productId, mirrorBatchId },
      },
      create: {
        shop, id: productId, mirrorBatchId, ...productData,
        lastSourceEntityUpdatedAt: productData.updatedAt || sourceEventOccurredAt,
        lastSourceEventOccurredAt: sourceEventOccurredAt,
        lastChangeSource: mutationType,
        isDeleted: false,
      },
      update: {
        ...productData,
        lastSourceEntityUpdatedAt: productData.updatedAt || sourceEventOccurredAt,
        lastSourceEventOccurredAt: sourceEventOccurredAt,
        lastChangeSource: mutationType,
        isDeleted: false,
      },
    });

    if (Array.isArray(variants)) {
      if (variants.length > 500) {
        throw new Error("Webhook variant mutation exceeds the 500-row transaction bound");
      }
      const incomingIds = variants.map((item) => item.id).filter(Boolean);
      if (incomingIds.length > 0) {
        const variantRows = variants.map((variant) => ({
          ...variant,
          option1Value: variant.selectedOptionsJson?.[0]?.value ?? null,
          option2Value: variant.selectedOptionsJson?.[1]?.value ?? null,
          option3Value: variant.selectedOptionsJson?.[2]?.value ?? null,
        }));
        const now = new Date();
        await tx.$executeRaw`
          INSERT INTO "Variant" (
            "shop", "id", "productId", "mirrorBatchId", "title", "sku", "barcode", "price",
            "compareAtPrice", "inventoryQuantity", "inventoryPolicy", "taxable", "taxCode",
            "position", "selectedOptionsJson", "option1Value", "option2Value", "option3Value",
            "sourceEntityUpdatedAt", "sourceEventOccurredAt", "lastChangeSource", "isDeleted", "createdAt", "updatedAt"
          )
          SELECT ${shop}, row."id", ${productId}, ${mirrorBatchId}, row."title", row."sku", row."barcode",
                 row."price"::numeric, row."compareAtPrice"::numeric, row."inventoryQuantity", row."inventoryPolicy",
                 row."taxable", row."taxCode", row."position", row."selectedOptionsJson",
                 row."option1Value", row."option2Value", row."option3Value",
                 ${productData.updatedAt || sourceEventOccurredAt}, ${sourceEventOccurredAt}, ${mutationType}, FALSE, ${now}, ${now}
          FROM jsonb_to_recordset(${JSON.stringify(variantRows)}::jsonb) AS row(
            "id" text, "title" text, "sku" text, "barcode" text, "price" text, "compareAtPrice" text,
            "inventoryQuantity" integer, "inventoryPolicy" text, "taxable" boolean, "taxCode" text,
            "position" integer, "selectedOptionsJson" jsonb, "option1Value" text, "option2Value" text, "option3Value" text
          )
          ON CONFLICT ("shop", "id", "mirrorBatchId") DO UPDATE SET
            "productId" = EXCLUDED."productId", "title" = EXCLUDED."title", "sku" = EXCLUDED."sku",
            "barcode" = EXCLUDED."barcode", "price" = EXCLUDED."price", "compareAtPrice" = EXCLUDED."compareAtPrice",
            "inventoryQuantity" = EXCLUDED."inventoryQuantity", "inventoryPolicy" = EXCLUDED."inventoryPolicy",
            "taxable" = EXCLUDED."taxable", "taxCode" = EXCLUDED."taxCode", "position" = EXCLUDED."position",
            "selectedOptionsJson" = EXCLUDED."selectedOptionsJson", "option1Value" = EXCLUDED."option1Value",
            "option2Value" = EXCLUDED."option2Value", "option3Value" = EXCLUDED."option3Value",
            "sourceEntityUpdatedAt" = EXCLUDED."sourceEntityUpdatedAt", "sourceEventOccurredAt" = EXCLUDED."sourceEventOccurredAt",
            "lastChangeSource" = EXCLUDED."lastChangeSource", "isDeleted" = FALSE, "updatedAt" = EXCLUDED."updatedAt"
          WHERE "Variant"."sourceEventOccurredAt" IS NULL
             OR EXCLUDED."sourceEventOccurredAt" >= "Variant"."sourceEventOccurredAt"
        `;
      }

      await tx.$executeRaw`
        INSERT INTO "VariantTombstone" (
          "shop", "variantId", "productId", "tombstoneMutationSequence", "sourceEventOccurredAt",
          "lastChangeSource", "deletedAt", "createdAt", "updatedAt"
        )
        SELECT variant."shop", variant."id", variant."productId", ${journal.sequence}, ${sourceEventOccurredAt},
          ${mutationType}, NOW(), NOW(), NOW()
        FROM "Variant" variant
        WHERE variant."shop" = ${shop} AND variant."productId" = ${productId}
          AND variant."mirrorBatchId" = ${mirrorBatchId}
          AND NOT (variant."id" = ANY(${incomingIds}::text[]))
        ON CONFLICT ("shop", "variantId") DO UPDATE SET
          "tombstoneMutationSequence" = EXCLUDED."tombstoneMutationSequence",
          "sourceEventOccurredAt" = EXCLUDED."sourceEventOccurredAt",
          "lastChangeSource" = EXCLUDED."lastChangeSource", "deletedAt" = EXCLUDED."deletedAt", "updatedAt" = NOW()
        WHERE "VariantTombstone"."sourceEventOccurredAt" IS NULL
           OR EXCLUDED."sourceEventOccurredAt" >= "VariantTombstone"."sourceEventOccurredAt"
      `;

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
      data: { mirrorMutationSequence: journal.sequence, status: "PENDING", updatedAt: new Date() },
    });

    return journal;
  }, { isolationLevel: "Serializable", maxWait: 10000, timeout: 20000 });
}

// Purge is sequence-safe: a tombstone remains while any unfinished catalog
// batch started before the delete mutation and could otherwise resurrect it.
export async function purgeSafeProductTombstones({ now = new Date() } = {}) {
  return db.$executeRaw`
    DELETE FROM "ProductTombstone" tombstone
    WHERE tombstone."purgeAfter" IS NOT NULL
      AND tombstone."purgeAfter" <= ${now}
      AND NOT EXISTS (
        SELECT 1
        FROM "MirrorBatch" batch
        WHERE batch."shop" = tombstone."shop"
          AND batch."resourceType" = 'PRODUCT_CATALOG'
          AND batch."finalizedSequence" IS NULL
          AND COALESCE(batch."syncStartSequence", 0) < tombstone."mutationSequence"
      )
  `;
}

// Journal rows are removable only after every unfinished catalog batch has
// advanced beyond the mutation sequence and the retention deadline has passed.
export async function purgeSafeMirrorMutationJournal({ now = new Date() } = {}) {
  return db.$executeRaw`
    DELETE FROM "MirrorMutationJournal" journal
    WHERE journal."purgeAfter" IS NOT NULL
      AND journal."purgeAfter" <= ${now}
      AND NOT EXISTS (
        SELECT 1
        FROM "MirrorBatch" batch
        WHERE batch."shop" = journal."shop"
          AND batch."resourceType" = 'PRODUCT_CATALOG'
          AND batch."finalizedSequence" IS NULL
          AND COALESCE(batch."syncStartSequence", 0) < journal."sequence"
      )
  `;
}
