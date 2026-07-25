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

  const actorId = firstNonEmpty(
    user?.id,
    user?._id,
    bodyActor?.id,
    req?.headers?.["x-actor-id"],
  );
  const actorEmail = firstNonEmpty(
    user?.email,
    bodyActor?.email,
    req?.headers?.["x-actor-email"],
  );
  const actorDisplayName = firstNonEmpty(
    user?.name,
    user?.fullName,
    bodyActor?.name,
    req?.headers?.["x-actor-name"],
  );

  const actorType =
    firstNonEmpty(
      user?.type,
      bodyActor?.type,
      req?.headers?.["x-actor-type"],
    ) ||
    (session?.shop ? "MERCHANT_ADMIN" : fallbackType);

  return {
    actorType,
    actorId,
    actorEmail,
    actorDisplayName,
  };
}
