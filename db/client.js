import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl || typeof databaseUrl !== "string" || !databaseUrl.trim()) {
  throw new Error(
    "Missing required env var DATABASE_URL. Expected a Neon Postgres connection string.",
  );
}

const sql = neon(databaseUrl);

export default sql;
export { sql };
