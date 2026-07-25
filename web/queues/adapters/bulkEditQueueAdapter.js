import { createJob } from "../../../db/syncJobs.js";
import { requireShopScope } from "../../utils/shopScope.js";

export async function enqueueBulkEditWrite(command) {
  const shopDomain = requireShopScope(command?.shopDomain, "shopDomain");
  const sessionId = String(command?.sessionId || "").trim();
  if (!sessionId) {
    throw new Error("enqueueBulkEditWrite requires sessionId");
  }

  const job = await createJob({
    shopDomain,
    type: "BULK_WRITE",
    meta: { sessionId },
  });

  return { jobId: job.id };
}
