import sql from "../db/client.js";
import { createJob } from "../db/syncJobs.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function enqueueMissingFullSyncForShop(shopDomain) {
  const recent = await sql`
    SELECT id
    FROM sync_jobs
    WHERE shop_id = ${shopDomain}
      AND type = 'FULL_SYNC'
      AND status = 'DONE'
      AND completed_at >= now() - interval '23 hours'
    ORDER BY completed_at DESC
    LIMIT 1
  `;
  if (recent.length > 0) return false;

  await createJob({
    shopDomain,
    type: "FULL_SYNC",
    meta: { source: "reconciliation" },
  });
  return true;
}

/**
 * Starts reconciliation cron loop.
 * @returns {void}
 */
export function startReconciliationCron() {
  const run = async () => {
    try {
      const shops = await sql`
        SELECT id
        FROM shops
        WHERE active = true
        ORDER BY id ASC
      `;

      for (const shop of shops) {
        try {
          const created = await enqueueMissingFullSyncForShop(shop.id);
          if (created) {
            console.log("[reconciliation] enqueued FULL_SYNC", { shopDomain: shop.id });
          }
        } catch (error) {
          console.error("[reconciliation] shop error", {
            shopDomain: shop.id,
            message: error?.message || String(error),
          });
        }
      }
    } catch (error) {
      console.error("[reconciliation] loop error", error?.message || error);
    }
  };

  setTimeout(() => {
    void run();
  }, 60_000);

  setInterval(() => {
    void run();
  }, DAY_MS);
}

