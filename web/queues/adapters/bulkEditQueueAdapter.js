import { createJob } from "../../../db/syncJobs.js";
import { requireShopScope } from "../../utils/shopScope.js";

export async function enqueueBulkEditWrite(command) {
  const shopId = requireShopScope(command?.shopId, "shopId");
  const sessionId = String(command?.sessionId || "").trim();
  if (!sessionId) {
    throw new Error("enqueueBulkEditWrite requires sessionId");
  }

  const job = await createJob({
    shopId,
    type: "BULK_WRITE",
    meta: { sessionId },
  });

  return { jobId: job.id };
}
