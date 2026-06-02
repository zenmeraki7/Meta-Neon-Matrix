import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const prismaGenerated = require("../generated/prisma/index.js");
const { Prisma } = prismaGenerated;

export { Prisma };
