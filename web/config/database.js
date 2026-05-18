// FILE: web/config/database.js adding to github
import { PrismaClient } from "../generated/prisma/index.js";
// Ensure a single instance of PrismaClient is used across the application
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}


export default prisma;
