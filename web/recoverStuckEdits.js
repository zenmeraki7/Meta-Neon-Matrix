// web/recoverStuckEdits.js
import dotenv from "dotenv";
dotenv.config();

import { prisma } from "./config/database.js";
import { handleProductEditOperation } from "./helpers/webhookHelpers/bulkOperations/bulkEdit.js";

const stuck = await prisma.editHistory.findMany({
  where: {
    status: "processing",
    executionState: "awaiting_shopify",
    bulkOperationId: { not: null },
    updatedAt: {
      lt: new Date(Date.now() - 3 * 60 * 1000),
    },
  },
  select: {
    id: true,
    shop: true,
    bulkOperationId: true,
  },
  orderBy: { updatedAt: "asc" },
  take: 25,
});

console.log(`Found ${stuck.length} stuck edits`);

for (const history of stuck) {
  console.log("Recovering", history.id, history.bulkOperationId);

  try {
    const result = await handleProductEditOperation({
      shop: history.shop,
      bulkOperationId: history.bulkOperationId,
    });

    console.log("Result", history.id, result);
  } catch (error) {
    console.error("Failed", {
      id: history.id,
      bulkOperationId: history.bulkOperationId,
      message: error.message,
    });
  }
}

await prisma.$disconnect();
process.exit(0);