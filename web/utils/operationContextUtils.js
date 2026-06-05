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

export function buildActorContext({ req = null, session = null, fallbackType = "SYSTEM" } = {}) {
  const user = req?.user || req?.authUser || null;
  const bodyActor = req?.body?.actor || null;
  const associatedUser = session?.onlineAccessInfo?.associated_user || null;

  const actorId = firstNonEmpty(
    user?.id,
    user?._id,
    associatedUser?.id ? String(associatedUser.id) : null,
    bodyActor?.id,
    req?.headers?.["x-actor-id"],
  );
  const actorEmail = firstNonEmpty(
    user?.email,
    associatedUser?.email,
    bodyActor?.email,
    req?.headers?.["x-actor-email"],
  );
  const actorName = firstNonEmpty(
    user?.name,
    user?.fullName,
    associatedUser?.first_name && associatedUser?.last_name
      ? `${associatedUser.first_name} ${associatedUser.last_name}`
      : associatedUser?.first_name || associatedUser?.last_name,
    bodyActor?.name,
    req?.headers?.["x-actor-name"],
  );

  const actorType =
    firstNonEmpty(
      user?.type,
      associatedUser?.id ? "SHOPIFY_USER" : null,
      bodyActor?.type,
      req?.headers?.["x-actor-type"],
    ) ||
    (session?.shop ? "MERCHANT_ADMIN" : fallbackType);

  return {
    actorType,
    actorId,
    actorEmail,
    actorName,
  };
}
