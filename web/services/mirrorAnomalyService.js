import { db } from "../repositories/repositoryDb.js";

export async function recordMirrorAnomaly({
  shop,
  severity = "medium",
  anomalyType = null,
  type = null,
  entityType = null,
  entityId = null,
  message,
  details = null,
}) {
  const resolvedAnomalyType = anomalyType || type;
  if (!shop || !resolvedAnomalyType || !message) {
    return null;
  }

  return db.mirrorAnomaly.create({
    data: {
      shop,
      severity,
      anomalyType: resolvedAnomalyType,
      entityType,
      entityId,
      message,
      details,
    },
  });
}
