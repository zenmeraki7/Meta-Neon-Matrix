import { getDefinitions } from "../db/metafieldDefinitions.js";

export async function getMetafieldDefinitions({ shop }) {
  const resolvedShop = String(shop || "").trim();
  if (!resolvedShop) {
    const error = new Error("Authentication required");
    error.code = "UNAUTHENTICATED";
    throw error;
  }

  return getDefinitions(resolvedShop);
}
