import { db } from "../repositories/repositoryDb.js";

export async function recordMirrorAnomaly({
  shop,
  severity = "medium",
  type,
  entityType = null,
  entityId = null,
  message,
  details = null,
}) {
  if (!shop || !type || !message) {
    return null;
  }

  return db.mirrorAnomaly.create({
    data: {
      shop,
      severity,
      type,
      entityType,
      entityId,
      message,
      details,
    },
  });
}

