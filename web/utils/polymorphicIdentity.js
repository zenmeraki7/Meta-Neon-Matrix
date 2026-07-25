function requireAllowedType(value, allowedTypes, fieldName) {
  const normalized = String(value || "").trim();
  const allowed = new Set(Array.from(allowedTypes || [], (item) => String(item).trim()));
  if (!normalized || allowed.size === 0 || !allowed.has(normalized)) {
    throw new Error(`INVALID_${fieldName.toUpperCase()}`);
  }
  return normalized;
}

function requireIdentityId(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`INVALID_${fieldName.toUpperCase()}`);
  return normalized;
}

// These constructors deliberately return domain-specific shapes. There is no
// generic { type, id } conversion because identities from separate domains are
// not interchangeable even when both values happen to be strings.
export function requireAggregateIdentity(input, allowedAggregateTypes) {
  return {
    aggregateType: requireAllowedType(input?.aggregateType, allowedAggregateTypes, "aggregateType"),
    aggregateId: requireIdentityId(input?.aggregateId, "aggregateId"),
  };
}

export function requireOwnerIdentity(input, allowedOwnerTypes) {
  return {
    ownerType: requireAllowedType(input?.ownerType, allowedOwnerTypes, "ownerType"),
    ownerId: requireIdentityId(input?.ownerId, "ownerId"),
  };
}

export function requireEntityIdentity(input, allowedEntityTypes) {
  return {
    entityType: requireAllowedType(input?.entityType, allowedEntityTypes, "entityType"),
    entityId: requireIdentityId(input?.entityId, "entityId"),
  };
}

export function requireResourceIdentity(input, allowedResourceTypes) {
  return {
    resourceType: requireAllowedType(input?.resourceType, allowedResourceTypes, "resourceType"),
    resourceId: requireIdentityId(input?.resourceId, "resourceId"),
  };
}

export function requireSourceIdentity(input, allowedSourceTypes) {
  return {
    sourceType: requireAllowedType(input?.sourceType, allowedSourceTypes, "sourceType"),
    sourceId: requireIdentityId(input?.sourceId, "sourceId"),
  };
}
