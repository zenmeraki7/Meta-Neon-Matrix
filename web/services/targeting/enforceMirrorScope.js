import { TargetingValidationError } from "./errors/TargetingValidationError.js";

function containsScopeKey(value, key) {
  if (Array.isArray(value)) {
    return value.some((item) => containsScopeKey(item, key));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return true;
  }
  return Object.values(value).some((child) => containsScopeKey(child, key));
}

export function enforceMirrorScope({ shop, mirrorBatchId, where = {} }) {
  if (!shop) {
    throw new TargetingValidationError("shop is required", { code: "SHOP_REQUIRED" });
  }
  if (!mirrorBatchId) {
    throw new TargetingValidationError("mirrorBatchId is required", { code: "MIRROR_BATCH_REQUIRED" });
  }
  if (containsScopeKey(where, "shop")) {
    throw new TargetingValidationError("filter payload must not include shop", {
      code: "PAYLOAD_SCOPE_FORBIDDEN",
      meta: { key: "shop" },
    });
  }
  if (containsScopeKey(where, "mirrorBatchId")) {
    throw new TargetingValidationError("filter payload must not include mirrorBatchId", {
      code: "PAYLOAD_SCOPE_FORBIDDEN",
      meta: { key: "mirrorBatchId" },
    });
  }

  return {
    AND: [
      where,
      { shop },
      { mirrorBatchId },
    ],
  };
}

export function enforceMirrorScopeSql({
  shop,
  mirrorBatchId,
  sqlText,
  params = [],
}) {
  if (!shop) {
    throw new TargetingValidationError("shop is required", { code: "SHOP_REQUIRED" });
  }
  if (!mirrorBatchId) {
    throw new TargetingValidationError("mirrorBatchId is required", { code: "MIRROR_BATCH_REQUIRED" });
  }
  if (!sqlText || typeof sqlText !== "string") {
    throw new TargetingValidationError("SQL text is required", { code: "SQL_REQUIRED" });
  }

  const nextParams = [...params, shop, mirrorBatchId];
  const shopParam = `$${nextParams.length - 1}`;
  const batchParam = `$${nextParams.length}`;
  const text = `(${sqlText}) AND ("shop" = ${shopParam} AND "mirrorBatchId" = ${batchParam})`;
  return { text, params: nextParams };
}
