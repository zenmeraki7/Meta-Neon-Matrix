// web/recoverStuckEdits.js
import dotenv from "dotenv";
dotenv.config();

import { prisma } from "./config/database.js";
import { handleProductEditOperation } from "./helpers/webhookHelpers/bulkOperations/bulkEdit.js";

const cutoff = new Date(Date.now() - 3 * 60 * 1000);

const stuck = await prisma.editHistory.findMany({
  where: {
    OR: [
      {
        status: "processing",
        executionState: "awaiting_shopify",
        bulkOperationId: { not: null },
        updatedAt: { lt: cutoff },
      },
      {
        undo: {
          path: ["status"],
          equals: "processing",
        },
        updatedAt: { lt: cutoff },
      },
    ],
  },
  select: {
    id: true,
    shop: true,
    status: true,
    executionState: true,
    bulkOperationId: true,
    undo: true,
    updatedAt: true,
  },
  orderBy: { updatedAt: "asc" },
  take: 25,
});

console.log(`Found ${stuck.length} stuck edit/undo histories`);

for (const history of stuck) {
  const undo = history.undo || {};

  const isUndo =
    undo?.status === "processing" &&
    undo?.state === "awaiting_shopify" &&
    undo?.bulkOperationId;

  const bulkOperationId = isUndo ? undo.bulkOperationId : history.bulkOperationId;

  if (!bulkOperationId) {
    console.log("Skipping missing bulkOperationId", history.id);
    continue;
  }

  console.log("Recovering", {
    id: history.id,
    shop: history.shop,
    bulkOperationId,
    mode: isUndo ? "undo" : "edit",
  });

  try {
    const result = await handleProductEditOperation({
      shop: history.shop,
      bulkOperationId,
    });

    console.log("Result", history.id, result);
  } catch (error) {
    console.error("Failed", {
      id: history.id,
      bulkOperationId,
      message: error.message,
    });
  }
}

await prisma.$disconnect();
process.exit(0);