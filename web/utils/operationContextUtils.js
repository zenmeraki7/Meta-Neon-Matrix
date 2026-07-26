import { normalizeShopDomain } from "./shopDomainUtils.js";

export function buildEntitlementSnapshot(subscription = null) {
  if (!subscription || typeof subscription !== "object") {
    return null;
  }

  return {
    planKey: subscription.planKey || null,
    planName: subscription.planName || null,
    status: subscription.status || null,
    limit:
      typeof subscription.limit === "number" && Number.isFinite(subscription.limit)
        ? subscription.limit
        : null,
    isUnlimited: Boolean(subscription.isUnlimited),
    capturedAt: new Date().toISOString(),
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Builds an actor context derived strictly from verified Shopify session state
 * or trusted server authentication middleware. Client-supplied body, query, or
 * header overrides are ignored.
 */
export function buildActorContext({
  req = null,
  session = null,
  shop = null,
  fallbackType = "SYSTEM",
} = {}) {
  const canonicalShop = shop || normalizeShopDomain(session?.shop);

  // Authenticated server middleware objects ONLY (e.g. req.user / req.authUser)
  const authUser = req?.user || req?.authUser || null;

  // Shopify Session associated user (online access token sessions)
  const sessionUser =
    session?.onlineAccessInfo?.associated_user ||
    session?.associated_user ||
    null;

  const actorId = firstNonEmpty(
    sessionUser?.id ? String(sessionUser.id) : null,
    authUser?.id ? String(authUser.id) : null,
    session?.id ? String(session.id) : null,
    canonicalShop,
  );

  const actorEmail = firstNonEmpty(
    sessionUser?.email,
    authUser?.email,
  );

  const actorDisplayName = firstNonEmpty(
    sessionUser?.first_name && sessionUser?.last_name
      ? `${sessionUser.first_name} ${sessionUser.last_name}`
      : null,
    sessionUser?.first_name || sessionUser?.last_name || null,
    authUser?.name || authUser?.fullName || null,
    canonicalShop,
  );

  const actorType = canonicalShop || session
    ? "MERCHANT_ADMIN"
    : fallbackType;

  return {
    actorType,
    actorId,
    actorEmail,
    actorDisplayName,
    shop: canonicalShop,
  };
}
