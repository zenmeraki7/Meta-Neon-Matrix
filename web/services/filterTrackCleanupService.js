import { prisma } from "../config/database.js";
import logger from "../utils/loggerUtils.js";

export async function purgeExpiredFilterTracks({ limit = 1000 } = {}) {
  const now = new Date();

  const candidates = await prisma.filterTrack.findMany({
    where: {
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
  const deleted = await prisma.filterTrack.deleteMany({
    where: { id: { in: ids } },
  });

  logger.info("Purged expired filter track rows", {
    deleted: deleted.count,
  });

  return { deleted: deleted.count };
}
