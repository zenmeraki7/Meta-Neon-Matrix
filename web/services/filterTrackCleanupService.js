import { db } from "../repositories/repositoryDb.js";
import logger from "../utils/loggerUtils.js";

export async function purgeExpiredFilterTracks({ shop, limit = 1000 } = {}) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("purgeExpiredFilterTracks requires shop");
  }
  const now = new Date();

  const candidates = await db.filterTrack.findMany({
    where: {
      shop: scopedShop,
      expiresAt: { lte: now },
    },
    select: { id: true },
    take: Math.max(1, Math.min(limit, 5000)),
    orderBy: { expiresAt: "asc" },
  });

  if (!candidates.length) {
    return { deleted: 0 };
  }

  const ids = candidates.map((row) => row.id);
  const deleted = await db.filterTrack.deleteMany({
    where: { shop: scopedShop, id: { in: ids } },
  });

  logger.info("Purged expired filter track rows", {
    shop: scopedShop,
    deleted: deleted.count,
  });

  return { deleted: deleted.count };
}

export async function purgeExpiredIdempotencyRecords({ shop, limit = 1000 } = {}) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("purgeExpiredIdempotencyRecords requires shop");
  }
  const now = new Date();

  const candidates = await db.idempotencyRecord.findMany({
    where: {
      shop: scopedShop,
      expiresAt: { lte: now },
    },
    select: { id: true },
    take: Math.max(1, Math.min(limit, 5000)),
    orderBy: { expiresAt: "asc" },
  });

  if (!candidates.length) {
    return { deleted: 0 };
  }

  const ids = candidates.map((row) => row.id);
  const deleted = await db.idempotencyRecord.deleteMany({
    where: { shop: scopedShop, id: { in: ids } },
  });

  logger.info("Purged expired idempotency records", {
    shop: scopedShop,
    deleted: deleted.count,
  });

  return { deleted: deleted.count };
}
