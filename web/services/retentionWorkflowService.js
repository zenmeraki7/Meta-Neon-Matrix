import { db } from "../repositories/repositoryDb.js";
import { normalizeShopDomain } from "../utils/shopDomainUtils.js";

const TERMINAL_EDIT_STATUSES = ["completed", "failed", "cancelled", "partial"];

export async function redactExpiredEditHistories({ shop, now = new Date(), limit = 100 }) {
  const canonicalShop = normalizeShopDomain(shop);
  if (!canonicalShop) throw new Error("RETENTION_CANONICAL_SHOP_REQUIRED");

  return db.$transaction(async (tx) => {
    const eligible = await tx.editHistory.findMany({
      where: {
        shop: canonicalShop,
        status: { in: TERMINAL_EDIT_STATUSES },
        retentionUntil: { lte: now },
        redactedAt: null,
        undoOperations: {
          every: {
            retentionUntil: { lte: now },
          },
        },
      },
      select: { id: true, shop: true },
      orderBy: [{ retentionUntil: "asc" }, { id: "asc" }],
      take: Math.max(1, Math.min(Number(limit) || 100, 500)),
    });
    if (!eligible.length) return { redacted: 0 };

    const ids = eligible.map(({ id }) => id);
    await tx.changeRecord.updateMany({
      where: {
        shop: canonicalShop,
        editHistoryId: { in: ids },
        retentionUntil: { lte: now },
        redactedAt: null,
      },
      data: {
        beforeValues: null,
        afterValues: null,
        options: null,
        productFieldChanges: null,
        variantFieldChanges: null,
        image: null,
        title: null,
        failureMessage: null,
        redactedAt: now,
      },
    });
    await tx.bulkEditRecoveryAudit.updateMany({
      where: {
        shop: canonicalShop,
        historyId: { in: ids },
        retentionUntil: { lte: now },
        redactedAt: null,
      },
      data: { actorEmail: null, metadata: null, redactedAt: now },
    });
    const updated = await tx.editHistory.updateMany({
      where: {
        shop: canonicalShop,
        id: { in: ids },
        status: { in: TERMINAL_EDIT_STATUSES },
        retentionUntil: { lte: now },
        redactedAt: null,
      },
      data: {
        actorEmail: null,
        actorDisplayName: null,
        legacyUser: null,
        error: null,
        entitlementSnapshot: null,
        redactedAt: now,
      },
    });
    return { redacted: updated.count };
  });
}

export async function cleanupExpiredOperationalPayloads({ now = new Date(), limit = 250 } = {}) {
  return db.$transaction(async (tx) => {
    const intents = await tx.operationEnqueueIntent.findMany({
      where: {
        status: { in: ["DISPATCHED", "FAILED"] },
        retentionUntil: { lte: now },
      },
      select: { id: true, shop: true },
      orderBy: [{ retentionUntil: "asc" }, { id: "asc" }],
      take: Math.max(1, Math.min(Number(limit) || 250, 1000)),
    });
    const events = await tx.outboxEvent.findMany({
      where: {
        status: { in: ["DISPATCHED", "DEAD_LETTER"] },
        retentionUntil: { lte: now },
      },
      select: { id: true, shop: true },
      orderBy: [{ retentionUntil: "asc" }, { id: "asc" }],
      take: Math.max(1, Math.min(Number(limit) || 250, 1000)),
    });

    let deletedIntents = 0;
    for (const intent of intents) {
      const result = await tx.operationEnqueueIntent.deleteMany({
        where: { id: intent.id, shop: intent.shop, status: { in: ["DISPATCHED", "FAILED"] }, retentionUntil: { lte: now } },
      });
      deletedIntents += result.count;
    }
    let deletedEvents = 0;
    for (const event of events) {
      const result = await tx.outboxEvent.deleteMany({
        where: { id: event.id, shop: event.shop, status: { in: ["DISPATCHED", "DEAD_LETTER"] }, retentionUntil: { lte: now } },
      });
      deletedEvents += result.count;
    }
    return { deletedIntents, deletedEvents };
  });
}
