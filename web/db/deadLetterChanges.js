import { prisma } from "../config/database.js";

/**
 * Moves one bulk_edit_changes row to dead_letter_changes and removes it from active ledger.
 * @param {string} changeId
 * @param {string} errorCode
 * @returns {Promise<number>}
 */
export async function moveToDeadLetter(changeId, shop, errorCode) {
  const resolvedId = String(changeId || "").trim();
  const resolvedShop = String(shop || "").trim();
  const resolvedError = String(errorCode || "UNKNOWN_ERROR").trim();
  if (!resolvedId || !resolvedShop) {
    throw new Error("moveToDeadLetter requires changeId and shop");
  }

  const rows = await prisma.$queryRaw`
    WITH deleted AS (
      DELETE FROM bulk_edit_changes
      WHERE id = ${resolvedId}::uuid
        AND shop_id = ${resolvedShop}
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

export async function markDeadLetterNotified(changeId, shop) {
  const resolvedId = String(changeId || "").trim();
  const resolvedShop = String(shop || "").trim();
  if (!resolvedId || !resolvedShop) {
    throw new Error("markDeadLetterNotified requires changeId and shop");
  }

  const rows = await prisma.$queryRaw`
    UPDATE dead_letter_changes
    SET notified = true
    WHERE id = ${resolvedId}::uuid
      AND shop_id = ${resolvedShop}
    RETURNING id
  `;
  return rows.length;
}

export async function moveRowsToDeadLetter(entries, shop) {
  const resolvedShop = String(shop || "").trim();
  const payload = (Array.isArray(entries) ? entries : []).map((entry) => ({
    id: String(entry.id),
    errorCode: String(entry.errorCode || "UNKNOWN_ERROR"),
  }));
  if (!payload.length || !resolvedShop) {
    throw new Error("moveRowsToDeadLetter requires entries and shop");
  }

  const rows = await prisma.$queryRaw`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
        AS x(id uuid, "errorCode" text)
    ),
    deleted AS (
      DELETE FROM bulk_edit_changes bec
      USING input
      WHERE bec.id = input.id
        AND bec.shop_id = ${resolvedShop}
      RETURNING bec.*, input."errorCode"
    )
    INSERT INTO dead_letter_changes (
      id, original_change, error_code, failed_at, shop_id, notified
    )
    SELECT
      deleted.id, to_jsonb(deleted.*) - 'errorCode', deleted."errorCode",
      now(), deleted.shop_id, false
    FROM deleted
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  return rows.length;
}

export async function markDeadLettersNotified(changeIds, shop) {
  const ids = (Array.isArray(changeIds) ? changeIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  const resolvedShop = String(shop || "").trim();
  if (!ids.length || !resolvedShop) {
    throw new Error("markDeadLettersNotified requires changeIds and shop");
  }
  const rows = await prisma.$queryRaw`
    UPDATE dead_letter_changes
    SET notified = true
    WHERE id = ANY(${ids}::uuid[])
      AND shop_id = ${resolvedShop}
    RETURNING id
  `;
  return rows.length;
}
