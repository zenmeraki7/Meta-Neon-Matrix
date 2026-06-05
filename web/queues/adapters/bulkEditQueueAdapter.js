import { prisma } from "../../config/database.js";
import { requireShopScope } from "../../utils/shopScope.js";

async function findBulkEditWriteJobBySession(tx, shopId, sessionId) {
  const rows = await tx.$queryRaw`
    SELECT *
    FROM sync_jobs
    WHERE shop_id = ${shopId}
      AND type = 'BULK_WRITE'
      AND meta->>'sessionId' = ${sessionId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function enqueueBulkEditWrite(command) {
  const shopId = requireShopScope(command?.shopId, "shopId");
  const sessionId = String(command?.sessionId || "").trim();
  if (!sessionId) {
    throw new Error("enqueueBulkEditWrite requires sessionId");
  }
  const changeCount = Number(command?.changeCount || 0);

  const job = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`bulk-edit-write:${shopId}:${sessionId}`}))
    `;

    const existingJob = await findBulkEditWriteJobBySession(tx, shopId, sessionId);
    if (existingJob) return existingJob;

    const rows = await tx.$queryRaw`
      INSERT INTO sync_jobs (shop_id, type, total_count, meta)
      VALUES (
        ${shopId},
        'BULK_WRITE',
        ${Number.isFinite(changeCount) ? changeCount : 0},
        ${JSON.stringify({ sessionId, changeCount: Number.isFinite(changeCount) ? changeCount : 0 })}::jsonb
      )
      RETURNING *
    `;
    return rows[0] || null;
  });

  return { jobId: job?.id || null };
}
