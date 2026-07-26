import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let Prisma = { sql: () => "", empty: "" };

try {
  const prismaGenerated = require("../generated/prisma/index.js");
  Prisma = prismaGenerated.Prisma || Prisma;
} catch {
  // Safe fallback when running unit tests without precompiled Prisma binaries
}

export { Prisma };
