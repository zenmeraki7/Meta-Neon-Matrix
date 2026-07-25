import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || typeof databaseUrl !== "string" || !databaseUrl.trim()) {
  throw new Error(
    "Missing required env var DATABASE_URL. Expected a Neon Postgres connection string.",
  );
}

const sql = neon(databaseUrl);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPaths = [
  path.join(__dirname, "schema", "layer1.sql"),
  path.join(__dirname, "schema", "layer2.sql"),
];

function splitStatements(sqlText) {
  return String(sqlText)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `${part};`);
}

async function run() {
  for (const schemaPath of schemaPaths) {
    const schemaSql = await fs.readFile(schemaPath, "utf8");
    const statements = splitStatements(schemaSql);

    console.log(`[migrate] Running ${statements.length} statements from ${schemaPath}`);

    for (let i = 0; i < statements.length; i += 1) {
      const statement = statements[i];
      try {
        await sql.query(statement);
        console.log(`[migrate] [${i + 1}/${statements.length}] OK`);
      } catch (error) {
        console.error(`[migrate] [${i + 1}/${statements.length}] FAILED`);
        console.error(statement);
        throw error;
      }
    }
  }

  console.log("[migrate] Layer 1 + Layer 2 migrations complete.");
}

run().catch((error) => {
  console.error("[migrate] Migration failed:", error?.message || error);
  process.exitCode = 1;
});
