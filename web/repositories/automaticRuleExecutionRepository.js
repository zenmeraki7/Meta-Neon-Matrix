import { prisma } from "../config/database.js";

export async function withAutomaticRuleExecutionTransaction(fn, options = {}) {
  return prisma.$transaction(async (tx) => fn(tx), options);
}

export async function tryAdvisoryLockTx(tx, lockKey) {
  const rows = await tx.$queryRaw`
    SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
  `;
  return Boolean(rows?.[0]?.locked);
}

export async function tryAdvisoryLockSession(lockKey) {
  const rows = await prisma.$queryRaw`
    SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS locked
  `;
  return Boolean(rows?.[0]?.locked);
}

export async function unlockAdvisoryLockSession(lockKey) {
  await prisma.$queryRaw`
    SELECT pg_advisory_unlock(hashtext(${lockKey}))
  `;
}

export async function createAutomaticRuleApplication(data, db = prisma) {
  return db.automaticRuleApplication.create({ data });
}

export async function findEditHistoryFirst(whereOrQuery, select = undefined, db = prisma) {
  if (
    whereOrQuery
    && typeof whereOrQuery === "object"
    && Object.prototype.hasOwnProperty.call(whereOrQuery, "where")
  ) {
    return db.editHistory.findFirst(whereOrQuery);
  }
  return db.editHistory.findFirst({ where: whereOrQuery, select });
}

export async function findEditHistoryUnique(whereOrQuery, select = undefined, db = prisma) {
  if (
    whereOrQuery
    && typeof whereOrQuery === "object"
    && Object.prototype.hasOwnProperty.call(whereOrQuery, "where")
  ) {
    return db.editHistory.findUnique(whereOrQuery);
  }
  return db.editHistory.findUnique({ where: whereOrQuery, select });
}

export async function createEditHistory(data, db = prisma) {
  return db.editHistory.create({ data });
}

export async function updateEditHistoryMany(whereOrQuery, data = undefined, db = prisma) {
  if (
    whereOrQuery
    && typeof whereOrQuery === "object"
    && Object.prototype.hasOwnProperty.call(whereOrQuery, "where")
  ) {
    return db.editHistory.updateMany(whereOrQuery);
  }
  return db.editHistory.updateMany({ where: whereOrQuery, data });
}
