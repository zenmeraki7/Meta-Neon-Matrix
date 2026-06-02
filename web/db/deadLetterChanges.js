import { prisma } from "../config/database.js";

/**
 * Moves one bulk_edit_changes row to dead_letter_changes and removes it from active ledger.
 * @param {string} changeId
 * @param {string} errorCode
 * @returns {Promise<number>}
 */
export async function moveToDeadLetter(changeId, errorCode) {
  const resolvedId = String(changeId || "").trim();
  const resolvedError = String(errorCode || "UNKNOWN_ERROR").trim();
  if (!resolvedId) throw new Error("moveToDeadLetter requires changeId");

  const rows = await prisma.$queryRaw`
    WITH deleted AS (
      DELETE FROM bulk_edit_changes
      WHERE id = ${resolvedId}::uuid
      RETURNING *
    )
    INSERT INTO dead_letter_changes (
      id,
      original_change,
      error_code,
      failed_at,
      shop_id,
      notified
    )
    SELECT
      deleted.id,
      to_jsonb(deleted.*),
      ${resolvedError},
      now(),
      deleted.shop_id,
      false
    FROM deleted
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;

  return rows.length;
}

export async function markDeadLetterNotified(changeId) {
  const resolvedId = String(changeId || "").trim();
  if (!resolvedId) throw new Error("markDeadLetterNotified requires changeId");

  const rows = await prisma.$queryRaw`
    UPDATE dead_letter_changes
    SET notified = true
    WHERE id = ${resolvedId}::uuid
    RETURNING id
  `;
  return rows.length;
}
