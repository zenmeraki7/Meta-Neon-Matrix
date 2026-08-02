import crypto from "crypto";
import { db } from "../repositories/repositoryDb.js";

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

function toDateMs(ms) {
  return new Date(Date.now() + ms);
}

export async function acquireOperationLease({
  shop,
  namespace,
  resourceId,
  ownerId,
  ttlMs = DEFAULT_LEASE_MS,
}) {
  if (!shop || !namespace || !resourceId || !ownerId) {
    throw new Error("operation lease requires shop, namespace, resourceId, and ownerId");
  }

  const now = new Date();
  const leaseId = `${namespace}:${shop}:${resourceId}`;
  const expiresAt = toDateMs(ttlMs);

  const result = await db.$executeRaw`
    INSERT INTO "OperationLease" ("shop","namespace","resourceId","ownerId","fencingToken","expiresAt","acquiredAt","heartbeatAt","releasedAt")
    VALUES (${shop}, ${namespace}, ${resourceId}, ${ownerId}, 1, ${expiresAt}, ${now}, ${now}, NULL)
    ON CONFLICT ("shop","namespace","resourceId")
    DO UPDATE SET
      "ownerId" = EXCLUDED."ownerId",
      "fencingToken" = "OperationLease"."fencingToken" + 1,
      "expiresAt" = EXCLUDED."expiresAt",
      "heartbeatAt" = EXCLUDED."heartbeatAt",
      "releasedAt" = NULL
    WHERE "OperationLease"."expiresAt" <= ${now}
  `;

  if (!result) {
    return { acquired: false, leaseId: null, fencingToken: null };
  }

  const lease = await db.operationLease.findUnique({
    where: { shop_namespace_resourceId: { shop, namespace, resourceId } },
    select: { fencingToken: true, ownerId: true, expiresAt: true },
  });

  if (!lease || lease.ownerId !== ownerId) {
    return { acquired: false, leaseId: null, fencingToken: null };
  }

  return { acquired: true, leaseId, fencingToken: lease.fencingToken };
}

export async function heartbeatOperationLease({
  shop,
  namespace,
  resourceId,
  ownerId,
  fencingToken = null,
  ttlMs = DEFAULT_LEASE_MS,
}) {
  const now = new Date();
  const expiresAt = toDateMs(ttlMs);
  const updated = await db.operationLease.updateMany({
    where: {
      shop,
      namespace,
      resourceId,
      ownerId,
      ...(fencingToken === null || fencingToken === undefined
        ? {}
        : { fencingToken: BigInt(fencingToken) }),
      expiresAt: { gt: now },
      releasedAt: null,
    },
    data: {
      expiresAt,
      heartbeatAt: now,
    },
  });
  return updated.count > 0;
}

export async function releaseOperationLease({
  shop,
  namespace,
  resourceId,
  ownerId,
  fencingToken = null,
}) {
  await db.operationLease.updateMany({
    where: {
      shop,
      namespace,
      resourceId,
      ownerId,
      ...(fencingToken === null || fencingToken === undefined
        ? {}
        : { fencingToken: BigInt(fencingToken) }),
      releasedAt: null,
    },
    data: {
      releasedAt: new Date(),
      expiresAt: new Date(),
    },
  });
}

export async function assertOperationLeaseOwnership({
  shop,
  namespace,
  resourceId,
  ownerId,
  fencingToken = null,
}) {
  const now = new Date();
  const lease = await db.operationLease.findUnique({
    where: { shop_namespace_resourceId: { shop, namespace, resourceId } },
    select: {
      ownerId: true,
      fencingToken: true,
      expiresAt: true,
      releasedAt: true,
    },
  });

  if (!lease) {
    const error = new Error("operation_lease_missing");
    error.code = "operation_lease_missing";
    throw error;
  }
  if (lease.releasedAt) {
    const error = new Error("operation_lease_released");
    error.code = "operation_lease_released";
    throw error;
  }
  if (lease.ownerId !== ownerId) {
    const error = new Error("operation_lease_owner_mismatch");
    error.code = "operation_lease_owner_mismatch";
    throw error;
  }
  if (
    fencingToken !== null &&
    fencingToken !== undefined &&
    lease.fencingToken !== BigInt(fencingToken)
  ) {
    const error = new Error("operation_lease_fencing_token_mismatch");
    error.code = "operation_lease_fencing_token_mismatch";
    throw error;
  }
  if (!(lease.expiresAt instanceof Date) || lease.expiresAt <= now) {
    const error = new Error("operation_lease_expired");
    error.code = "operation_lease_expired";
    throw error;
  }

  return {
    ownerId: lease.ownerId,
    fencingToken: Number(lease.fencingToken || 0),
    expiresAt: lease.expiresAt,
  };
}

export function buildLeaseOwnerId(prefix = "worker") {
  return `${prefix}:${crypto.randomUUID()}`;
}
