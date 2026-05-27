import { prisma } from "../config/database.js";
import {
  buildEncryptedTokenColumns,
  canEncryptTokens,
} from "../utils/tokenCrypto.js";

async function run() {
  if (!canEncryptTokens()) {
    console.error(
      "ACCESS_TOKEN_ENCRYPTION_KEY is not configured or invalid; cannot backfill encrypted tokens.",
    );
    process.exit(1);
  }

  const batchSize = 200;
  let cursor = null;
  let updated = 0;

  for (;;) {
    const rows = await prisma.store.findMany({
      where: {
        accessToken: { not: null },
        OR: [{ accessTokenEncrypted: null }, { accessTokenKeyVersion: null }],
      },
      select: {
        id: true,
        shopUrl: true,
        accessToken: true,
      },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      const columns = buildEncryptedTokenColumns(row.accessToken);
      if (!columns.accessTokenEncrypted) continue;

      await prisma.store.update({
        where: { id: row.id },
        data: {
          accessTokenEncrypted: columns.accessTokenEncrypted,
          accessTokenKeyVersion: columns.accessTokenKeyVersion,
        },
      });
      updated += 1;
    }

    cursor = rows[rows.length - 1].id;
  }

  console.log(`Backfill completed. Updated stores: ${updated}`);
}

run()
  .catch((err) => {
    console.error("Backfill failed:", err?.message || err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
