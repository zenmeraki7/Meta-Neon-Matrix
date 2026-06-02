import { prisma } from "../config/database.js";

const WRITABLE_SYNC_STATUSES = ["SYNCED", "WRITTEN"];

function assertSessionScope(sessionId, shop) {
  const resolvedSessionId = String(sessionId || "").trim();
  const resolvedShop = String(shop || "").trim();
  if (!resolvedSessionId || !resolvedShop) {
    throw new Error("sessionId and shop are required");
  }
  return { resolvedSessionId, resolvedShop };
}

/**
 * Stages/commits per-cell ledger rows and projects pending UI state.
 * @param {string} sessionId
 * @param {string} shop
 * @param {Array<{variantId:string|number|bigint,definitionId?:string|null,namespace:string,key:string,type:string,newValue:string,compareDigest:string|null,shopifyOwnerId?:string|null}>} cells
 * @returns {Promise<{staged:number}>}
 */
export async function stageChanges(sessionId, shop, cells) {
  const { resolvedSessionId, resolvedShop } = assertSessionScope(sessionId, shop);
  const list = Array.isArray(cells) ? cells : [];
  if (!list.length) return { staged: 0 };

  await prisma.$transaction(async (tx) => {
    for (const cell of list) {
      const variantId = BigInt(cell.variantId).toString();
      const namespace = String(cell.namespace || "").trim();
      const key = String(cell.key || "").trim();
      const type = String(cell.type || "").trim();
      const newValue = cell.newValue == null ? null : String(cell.newValue);
      const compareDigest = cell.compareDigest == null ? null : String(cell.compareDigest);
      const shopifyOwnerId =
        String(cell.shopifyOwnerId || "").trim()
        || `gid://shopify/ProductVariant/${variantId}`;
      const definitionId = cell.definitionId ? String(cell.definitionId) : null;

      // Immutable ledger row upsert (one row identity per session+variant+namespace+key).
      // Never derive write source from pending_value.
      await tx.$queryRaw`
        INSERT INTO bulk_edit_changes (
          session_id,
          shop_id,
          variant_id,
          definition_id,
          namespace,
          key,
          type,
          shopify_owner_id,
          old_value,
          new_value,
          compare_digest,
          status,
          attempt_count,
          created_at
        )
        SELECT
          ${resolvedSessionId}::uuid,
          vm.shop_id,
          vm.variant_id,
          COALESCE(${definitionId}::uuid, vm.definition_id),
          vm.namespace,
          vm.key,
          COALESCE(NULLIF(${type}, ''), vm.type),
          ${shopifyOwnerId},
          vm.value,
          ${newValue},
          COALESCE(${compareDigest}, vm.compare_digest),
          'PENDING',
          0,
          now()
        FROM variant_metafields vm
        WHERE vm.shop_id = ${resolvedShop}
          AND vm.variant_id = ${variantId}::bigint
          AND vm.namespace = ${namespace}
          AND vm.key = ${key}
        ON CONFLICT (session_id, variant_id, namespace, key)
        DO UPDATE SET
          new_value = EXCLUDED.new_value,
          compare_digest = EXCLUDED.compare_digest,
          status = 'PENDING',
          shopify_error = NULL
      `;

      // Pending projection for UI only, guarded so sync-safe states are not clobbered.
      await tx.$queryRaw`
        UPDATE variant_metafields
        SET
          pending_value = ${newValue},
          edit_status = 'PENDING',
          last_edited_at = now()
        WHERE shop_id = ${resolvedShop}
          AND variant_id = ${variantId}::bigint
          AND namespace = ${namespace}
          AND key = ${key}
      `;
    }
  });

  return { staged: list.length };
}

/**
 * Applies one value to one metafield column across variant ids and creates ledger rows per variant.
 * @param {string} sessionId
 * @param {string} shop
 * @param {string} namespace
 * @param {string} key
 * @param {string|null} value
 * @param {Array<string|number|bigint>} variantIds
 * @returns {Promise<{staged:number}>}
 */
export async function columnApplyFanout(sessionId, shop, namespace, key, value, variantIds) {
  const { resolvedSessionId, resolvedShop } = assertSessionScope(sessionId, shop);
  const resolvedNamespace = String(namespace || "").trim();
  const resolvedKey = String(key || "").trim();
  if (!resolvedNamespace || !resolvedKey) {
    throw new Error("namespace and key are required");
  }
  const ids = (Array.isArray(variantIds) ? variantIds : []).map((id) => BigInt(id).toString());
  if (!ids.length) return { staged: 0 };

  const newValue = value == null ? null : String(value);

  const inserted = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      UPDATE variant_metafields
      SET
        pending_value = ${newValue},
        edit_status = 'PENDING',
        last_edited_at = now()
      WHERE shop_id = ${resolvedShop}
        AND namespace = ${resolvedNamespace}
        AND key = ${resolvedKey}
        AND variant_id = ANY(${ids}::bigint[])
    `;

    const rows = await tx.$queryRaw`
      INSERT INTO bulk_edit_changes (
        session_id,
        shop_id,
        variant_id,
        definition_id,
        namespace,
        key,
        type,
        shopify_owner_id,
        old_value,
        new_value,
        compare_digest,
        status,
        attempt_count,
        created_at
      )
      SELECT
        ${resolvedSessionId}::uuid,
        vm.shop_id,
        vm.variant_id,
        vm.definition_id,
        vm.namespace,
        vm.key,
        vm.type,
        'gid://shopify/ProductVariant/' || vm.variant_id::text,
        vm.value,
        ${newValue},
        vm.compare_digest,
        'PENDING',
        0,
        now()
      FROM variant_metafields vm
      WHERE vm.shop_id = ${resolvedShop}
        AND vm.namespace = ${resolvedNamespace}
        AND vm.key = ${resolvedKey}
        AND vm.variant_id = ANY(${ids}::bigint[])
      ON CONFLICT (session_id, variant_id, namespace, key)
      DO UPDATE SET
        new_value = EXCLUDED.new_value,
        compare_digest = EXCLUDED.compare_digest,
        status = 'PENDING',
        shopify_error = NULL
      RETURNING id
    `;
    return rows.length;
  });

  return { staged: inserted };
}

/**
 * Lists pending ledger rows (worker execution source of truth).
 * @param {string} sessionId
 * @param {string} shop
 * @returns {Promise<Array<object>>}
 */
export async function listPendingLedgerRows(sessionId, shop) {
  const { resolvedSessionId, resolvedShop } = assertSessionScope(sessionId, shop);
  return prisma.$queryRaw`
    SELECT
      bec.id,
      bec.session_id,
      bec.shop_id,
      bec.variant_id,
      bec.definition_id,
      bec.namespace,
      bec.key,
      bec.type,
      bec.shopify_owner_id,
      bec.old_value,
      bec.new_value,
      bec.compare_digest,
      bec.status,
      bec.attempt_count,
      bec.shopify_error,
      bec.created_at,
      bec.applied_at,
      vm.shopify_metafield_id
    FROM bulk_edit_changes bec
    LEFT JOIN variant_metafields vm
      ON vm.shop_id = bec.shop_id
     AND vm.variant_id = bec.variant_id
     AND vm.namespace = bec.namespace
     AND vm.key = bec.key
    WHERE bec.session_id = ${resolvedSessionId}::uuid
      AND bec.shop_id = ${resolvedShop}
      AND bec.status = 'PENDING'
    ORDER BY bec.created_at ASC, bec.id ASC
  `;
}

/**
 * Counts ledger rows for one status in session scope.
 * @param {string} sessionId
 * @param {string} shop
 * @param {string} status
 * @returns {Promise<number>}
 */
export async function countRowsByStatus(sessionId, shop, status) {
  const { resolvedSessionId, resolvedShop } = assertSessionScope(sessionId, shop);
  const resolvedStatus = String(status || "").trim().toUpperCase();
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM bulk_edit_changes
    WHERE session_id = ${resolvedSessionId}::uuid
      AND shop_id = ${resolvedShop}
      AND status = ${resolvedStatus}
  `;
  return Number(rows[0]?.count || 0);
}

/**
 * Aggregates ledger counts grouped by status in session scope.
 * @param {string} sessionId
 * @param {string} shop
 * @returns {Promise<Array<{status:string,count:number}>>}
 */
export async function getStatusCounts(sessionId, shop) {
  const { resolvedSessionId, resolvedShop } = assertSessionScope(sessionId, shop);
  const rows = await prisma.$queryRaw`
    SELECT status, COUNT(*)::int AS count
    FROM bulk_edit_changes
    WHERE session_id = ${resolvedSessionId}::uuid
      AND shop_id = ${resolvedShop}
    GROUP BY status
  `;
  return rows.map((row) => ({
    status: String(row.status || "").toUpperCase(),
    count: Number(row.count || 0),
  }));
}

/**
 * Canonical alias for progress counts grouped by status.
 * @param {string} sessionId
 * @returns {Promise<Array<{status:string,count:number}>>}
 */
export async function getProgressCounts(sessionId) {
  const resolvedSessionId = String(sessionId || "").trim();
  if (!resolvedSessionId) {
    throw new Error("getProgressCounts requires sessionId");
  }

  const rows = await prisma.$queryRaw`
    SELECT status, COUNT(*)::int AS count
    FROM bulk_edit_changes
    WHERE session_id = ${resolvedSessionId}::uuid
    GROUP BY status
  `;
  return rows.map((row) => ({
    status: String(row.status || "").toUpperCase(),
    count: Number(row.count || 0),
  }));
}

/**
 * Marks a ledger row as WRITING.
 * @param {string} changeId
 * @returns {Promise<number>}
 */
export async function markRowWriting(changeId) {
  const resolvedId = String(changeId || "").trim();
  if (!resolvedId) throw new Error("markRowWriting requires changeId");
  const rows = await prisma.$transaction(async (tx) => {
    const changed = await tx.$queryRaw`
      UPDATE bulk_edit_changes
      SET
        status = 'WRITING',
        attempt_count = COALESCE(attempt_count, 0) + 1
      WHERE id = ${resolvedId}::uuid
      RETURNING shop_id, variant_id, namespace, key
    `;
    if (!changed.length) return [];
    const row = changed[0];
    await tx.$queryRaw`
      UPDATE variant_metafields
      SET edit_status = 'WRITING'
      WHERE shop_id = ${String(row.shop_id)}
        AND variant_id = ${BigInt(row.variant_id).toString()}::bigint
        AND namespace = ${String(row.namespace)}
        AND key = ${String(row.key)}
    `;
    return changed;
  });
  return rows.length;
}

/**
 * Marks a ledger row as WRITTEN and clears pending UI state on the mirror row.
 * @param {string} changeId
 * @param {string|null} confirmedValue
 * @param {string|null} digest
 * @returns {Promise<number>}
 */
export async function markRowWritten(changeId, confirmedValue, digest) {
  const resolvedId = String(changeId || "").trim();
  if (!resolvedId) throw new Error("markRowWritten requires changeId");

  const count = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      UPDATE bulk_edit_changes
      SET
        status = 'WRITTEN',
        applied_at = now(),
        shopify_error = NULL
      WHERE id = ${resolvedId}::uuid
      RETURNING shop_id, variant_id, namespace, key, new_value
    `;
    if (!rows.length) return 0;
    const row = rows[0];
    const valueToPersist =
      confirmedValue == null ? (row.new_value == null ? null : String(row.new_value)) : String(confirmedValue);

    await tx.$queryRaw`
      UPDATE variant_metafields
      SET
        value = ${valueToPersist},
        pending_value = NULL,
        compare_digest = ${digest == null ? null : String(digest)},
        edit_status = 'WRITTEN',
        last_synced_at = now()
      WHERE shop_id = ${String(row.shop_id)}
        AND variant_id = ${BigInt(row.variant_id).toString()}::bigint
        AND namespace = ${String(row.namespace)}
        AND key = ${String(row.key)}
    `;
    return 1;
  });

  return count;
}

/**
 * Marks a ledger row as ERROR and keeps pending_value visible.
 * @param {string} changeId
 * @param {string} errorCode
 * @param {boolean} retryable
 * @returns {Promise<number>}
 */
export async function markRowError(changeId, errorCode, retryable) {
  const resolvedId = String(changeId || "").trim();
  const code = String(errorCode || "UNKNOWN_ERROR").trim();
  if (!resolvedId) throw new Error("markRowError requires changeId");

  const rows = await prisma.$transaction(async (tx) => {
    const updated = await tx.$queryRaw`
      UPDATE bulk_edit_changes
      SET
        status = 'ERROR',
        shopify_error = ${code},
        retryable = ${Boolean(retryable)}
      WHERE id = ${resolvedId}::uuid
      RETURNING shop_id, variant_id, namespace, key
    `;
    if (!updated.length) return [];
    const row = updated[0];
    await tx.$queryRaw`
      UPDATE variant_metafields
      SET
        edit_status = 'ERROR'
      WHERE shop_id = ${String(row.shop_id)}
        AND variant_id = ${BigInt(row.variant_id).toString()}::bigint
        AND namespace = ${String(row.namespace)}
        AND key = ${String(row.key)}
    `;
    return updated;
  });

  return rows.length;
}

export const BULK_EDIT_SYNC_WRITABLE_STATUSES = Object.freeze(WRITABLE_SYNC_STATUSES);

export async function getSessionPreview(sessionId, shop) {
  const { resolvedSessionId, resolvedShop } = assertSessionScope(sessionId, shop);
  const rows = await prisma.$queryRaw`
    SELECT
      COUNT(*)::int AS total_cells,
      COUNT(DISTINCT v.product_id)::int AS affected_products,
      CEIL(COUNT(*)::numeric / 25.0 * 0.5)::int AS estimated_seconds
    FROM bulk_edit_changes bec
    JOIN variants v
      ON v.shop_id = bec.shop_id
     AND v.id = bec.variant_id
    WHERE bec.session_id = ${resolvedSessionId}::uuid
      AND bec.shop_id = ${resolvedShop}
      AND bec.status = 'PENDING'
  `;
  return {
    totalCells: Number(rows?.[0]?.total_cells || 0),
    affectedProducts: Number(rows?.[0]?.affected_products || 0),
    estimatedSeconds: Number(rows?.[0]?.estimated_seconds || 0),
  };
}

export async function getColumnErrorSummary(sessionId, shop) {
  const { resolvedSessionId, resolvedShop } = assertSessionScope(sessionId, shop);
  const rows = await prisma.$queryRaw`
    SELECT namespace, key, COUNT(*)::int AS error_count
    FROM bulk_edit_changes
    WHERE session_id = ${resolvedSessionId}::uuid
      AND shop_id = ${resolvedShop}
      AND status = 'ERROR'
    GROUP BY namespace, key
    ORDER BY error_count DESC
  `;
  return rows.map((r) => ({
    namespace: String(r.namespace || ""),
    key: String(r.key || ""),
    errorCount: Number(r.error_count || 0),
  }));
}

export async function getErrorVariantIdsForColumn(sessionId, shop, namespace, key) {
  const { resolvedSessionId, resolvedShop } = assertSessionScope(sessionId, shop);
  const resolvedNamespace = String(namespace || "").trim();
  const resolvedKey = String(key || "").trim();
  if (!resolvedNamespace || !resolvedKey) {
    throw new Error("namespace and key are required");
  }

  const rows = await prisma.$queryRaw`
    SELECT DISTINCT variant_id
    FROM bulk_edit_changes
    WHERE session_id = ${resolvedSessionId}::uuid
      AND shop_id = ${resolvedShop}
      AND status = 'ERROR'
      AND namespace = ${resolvedNamespace}
      AND key = ${resolvedKey}
  `;
  return rows.map((r) => String(r.variant_id));
}

export async function discardPendingChanges(sessionId, shop) {
  const { resolvedSessionId, resolvedShop } = assertSessionScope(sessionId, shop);
  return prisma.$transaction(async (tx) => {
    const touched = await tx.$queryRaw`
      SELECT DISTINCT variant_id, namespace, key
      FROM bulk_edit_changes
      WHERE session_id = ${resolvedSessionId}::uuid
        AND shop_id = ${resolvedShop}
        AND status = 'PENDING'
    `;

    await tx.$queryRaw`
      UPDATE variant_metafields vm
      SET
        pending_value = NULL,
        edit_status = 'SYNCED',
        is_dirty = false
      FROM (
        SELECT DISTINCT variant_id, namespace, key
        FROM bulk_edit_changes
        WHERE session_id = ${resolvedSessionId}::uuid
          AND shop_id = ${resolvedShop}
          AND status = 'PENDING'
      ) pend
      WHERE vm.shop_id = ${resolvedShop}
        AND vm.variant_id = pend.variant_id
        AND vm.namespace = pend.namespace
        AND vm.key = pend.key
    `;

    await tx.$queryRaw`
      DELETE FROM bulk_edit_changes
      WHERE session_id = ${resolvedSessionId}::uuid
        AND shop_id = ${resolvedShop}
        AND status = 'PENDING'
    `;

    return { discarded: touched.length };
  });
}
