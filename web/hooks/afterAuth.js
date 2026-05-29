import { upsertShop } from "../../db/shops.js";
import { createJob, getActiveJob } from "../../db/syncJobs.js";

/**
 * Template afterAuth hook.
 * @param {{ session: { shop: string, scope: string } }} params
 * @returns {Promise<void>}
 * @throws {Error}
 */
export default async function afterAuth({ session }) {
  try {
    const shopDomain = String(session?.shop || "").trim();
    const scope = String(session?.scope || "").trim();
    if (!shopDomain || !scope) {
      throw new Error("afterAuth requires session.shop and session.scope");
    }

    await upsertShop({ shopDomain, scope });

    const existing = await getActiveJob(shopDomain, "FULL_SYNC");
    if (!existing) {
      const created = await createJob({
        shopId: shopDomain,
        type: "FULL_SYNC",
        meta: {},
      });
      console.log("[afterAuth] FULL_SYNC job created", {
        shop: shopDomain,
        jobId: created?.id || null,
      });
      return;
    }

    console.log("[afterAuth] FULL_SYNC already active", {
      shop: shopDomain,
      jobId: existing?.id || null,
      status: existing?.status || null,
    });
  } catch (error) {
    console.error("[afterAuth] failed to persist shop/sync bootstrap", {
      message: error?.message || String(error),
    });
  }
}

