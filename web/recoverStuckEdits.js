// web/recoverStuckEdits.js
import dotenv from "dotenv";
dotenv.config();

import { db } from "./repositories/repositoryDb.js";
import { addbulkEditResultIngestJob } from "./Jobs/Queues/bulkEditResultIngestJob.js";
import { addbulkUndoResultIngestJob } from "./Jobs/Queues/bulkUndoResultIngestJob.js";

const cutoff = new Date(Date.now() - 3 * 60 * 1000);

const stuck = await db.editHistory.findMany({
  where: {
    OR: [
      {
        status: "processing",
        executionState: "awaiting_shopify",
        shopifyBulkOperationId: { not: null },
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
    shopifyBulkOperationId: true,
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
    undo?.shopifyBulkOperationId;

  const shopifyBulkOperationId = isUndo ? undo.shopifyBulkOperationId : history.shopifyBulkOperationId;

  if (!shopifyBulkOperationId) {
    console.log("Skipping missing shopifyBulkOperationId", history.id);
    continue;
  }

  console.log("Recovering", {
    id: history.id,
    shop: history.shop,
    shopifyBulkOperationId,
    mode: isUndo ? "undo" : "edit",
  });

  try {
    const result = isUndo
      ? await addbulkUndoResultIngestJob({
          shop: history.shop,
          shopifyBulkOperationId,
          source: "manual_stuck_recovery",
        })
      : await addbulkEditResultIngestJob({
          shop: history.shop,
          shopifyBulkOperationId,
          source: "manual_stuck_recovery",
        });

    console.log("Result", history.id, result);
  } catch (error) {
    console.error("Failed", {
      id: history.id,
      shopifyBulkOperationId,
      message: error.message,
    });
  }
}

await db.$disconnect();
process.exit(0);

