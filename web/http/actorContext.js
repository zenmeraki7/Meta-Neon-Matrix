export function buildActorFromSession(session) {
  const associatedUser = session?.onlineAccessInfo?.associated_user;

  return Object.freeze({
    type: associatedUser?.id ? "SHOPIFY_USER" : "SHOPIFY_SESSION",
    userId: associatedUser?.id ? String(associatedUser.id) : null,
    email: associatedUser?.email || null,
  });
}
