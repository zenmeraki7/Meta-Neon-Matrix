import "dotenv/config";
import pg from "pg";
import {
  buildEncryptedTokenColumns,
  canEncryptTokens,
} from "../utils/tokenCrypto.js";

if (!canEncryptTokens()) {
  throw new Error(
    "ACCESS_TOKEN_ENCRYPTION_KEY must be configured as 64 hexadecimal characters",
  );
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query("BEGIN");
  const stores = await client.query(`
    SELECT "id", "accessToken"
    FROM "Store"
    WHERE "accessToken" IS NOT NULL
      AND "accessTokenEncrypted" IS NULL
    FOR UPDATE
  `);

  for (const store of stores.rows) {
    const encrypted = buildEncryptedTokenColumns(store.accessToken);
    await client.query(
      `UPDATE "Store"
       SET "accessTokenEncrypted" = $1,
           "accessTokenKeyVersion" = $2,
           "accessToken" = NULL
       WHERE "id" = $3
         AND "accessTokenEncrypted" IS NULL`,
      [encrypted.accessTokenEncrypted, encrypted.accessTokenKeyVersion, store.id],
    );
  }

  await client.query("COMMIT");
  console.log(`Encrypted and cleared ${stores.rowCount} plaintext store token(s).`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
