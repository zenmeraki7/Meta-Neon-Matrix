export function requireShopScope(shop, fieldName = "shop") {
  const resolved = String(shop || "").trim();
  if (!resolved) {
    const error = new Error(`${fieldName} is required`);
    error.code = "SHOP_SCOPE_REQUIRED";
    throw error;
  }
  return resolved;
}

export function buildShopScopedKey(shop, ...parts) {
  const resolvedShop = requireShopScope(shop);
  const suffix = parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(":");
  return suffix ? `${resolvedShop}:${suffix}` : resolvedShop;
}

