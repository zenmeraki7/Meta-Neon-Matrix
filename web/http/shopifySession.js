export function requireShopifySession(res, message = "Unauthenticated Shopify session") {
  const session = res.locals?.shopify?.session;

  if (!session?.shop) {
    const error = new Error(message);
    error.code = "UNAUTHENTICATED";
    throw error;
  }

  return session;
}
