import { prisma } from "../config/database.js";

const boundedLimit = (limit) => Math.max(1, Math.min(Number(limit) || 100, 500));

export async function claimDueRecurringEditSchedules({ now, ownerId, leaseUntil, limit = 100 }, db = prisma) {
  return db.$queryRaw`
    WITH due AS (
      SELECT state."shop", state."recurringEditId"
      FROM "RecurringEditScheduleState" state
      WHERE state."disabledAt" IS NULL
        AND state."nextRunAt" <= ${now}
        AND (state."claimExpiresAt" IS NULL OR state."claimExpiresAt" < ${now})
      ORDER BY state."nextRunAt", state."shop", state."recurringEditId"
      LIMIT ${boundedLimit(limit)}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "RecurringEditScheduleState" state SET
      "claimedAt"=${now}, "claimOwner"=${ownerId}, "claimExpiresAt"=${leaseUntil},
      "fencingToken"=state."fencingToken" + 1, "updatedAt"=${now}
    FROM due
    WHERE state."shop"=due."shop" AND state."recurringEditId"=due."recurringEditId"
    RETURNING state.*
  `;
}

export async function claimDueScheduledExportSchedules({ now, ownerId, leaseUntil, limit = 100 }, db = prisma) {
  return db.$queryRaw`
    WITH due AS (
      SELECT state."shop", state."scheduledExportId"
      FROM "ScheduledExportScheduleState" state
      WHERE state."disabledAt" IS NULL
        AND state."nextRunAt" <= ${now}
        AND (state."claimExpiresAt" IS NULL OR state."claimExpiresAt" < ${now})
      ORDER BY state."nextRunAt", state."shop", state."scheduledExportId"
      LIMIT ${boundedLimit(limit)}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "ScheduledExportScheduleState" state SET
      "claimedAt"=${now}, "claimOwner"=${ownerId}, "claimExpiresAt"=${leaseUntil},
      "fencingToken"=state."fencingToken" + 1, "updatedAt"=${now}
    FROM due
    WHERE state."shop"=due."shop" AND state."scheduledExportId"=due."scheduledExportId"
    RETURNING state.*
  `;
}

export async function advanceRecurringEditScheduleClaim({ claim, nextRunAt }, db = prisma) {
  return db.recurringEditScheduleState.updateMany({
    where: {
      shop: claim.shop, recurringEditId: claim.recurringEditId,
      definitionRevision: claim.definitionRevision, scheduleVersion: claim.scheduleVersion,
      claimOwner: claim.claimOwner, fencingToken: claim.fencingToken,
    },
    data: {
      nextRunAt, claimedAt: null, claimOwner: null, claimExpiresAt: null,
      disabledAt: nextRunAt ? null : new Date(),
    },
  });
}

export async function advanceScheduledExportScheduleClaim({ claim, nextRunAt }, db = prisma) {
  return db.scheduledExportScheduleState.updateMany({
    where: {
      shop: claim.shop, scheduledExportId: claim.scheduledExportId,
      definitionRevision: claim.definitionRevision, scheduleVersion: claim.scheduleVersion,
      claimOwner: claim.claimOwner, fencingToken: claim.fencingToken,
    },
    data: {
      nextRunAt, claimedAt: null, claimOwner: null, claimExpiresAt: null,
      disabledAt: nextRunAt ? null : new Date(),
    },
  });
}
