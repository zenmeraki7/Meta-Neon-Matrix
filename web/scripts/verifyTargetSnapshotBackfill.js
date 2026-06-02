import { db } from "../repositories/repositoryDb.js";

async function countNullAssignments() {
  const [nullSnapshotSetId, nullTargetKey] = await Promise.all([
    db.targetSnapshotItem.count({
      where: {
        snapshotSetId: null,
      },
    }),
    db.targetSnapshotItem.count({
      where: {
        targetKey: null,
      },
    }),
  ]);

  return {
    nullSnapshotSetId,
    nullTargetKey,
  };
}

async function findDuplicateSnapshotSetTargetKeys(limit = 100) {
  const rows = await db.$queryRawUnsafe(
    `
      SELECT
        "snapshotSetId",
        "targetKey",
        COUNT(*)::int AS "rowCount"
      FROM "TargetSnapshotItem"
      WHERE "snapshotSetId" IS NOT NULL
        AND "targetKey" IS NOT NULL
      GROUP BY "snapshotSetId", "targetKey"
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, "snapshotSetId" ASC, "targetKey" ASC
      LIMIT $1
    `,
    Number(limit),
  );
  return Array.isArray(rows) ? rows : [];
}

async function findNonFrozenSets(limit = 200) {
  return db.targetSnapshotSet.findMany({
    where: {
      status: {
        not: "FROZEN",
      },
    },
    select: {
      id: true,
      shop: true,
      operationId: true,
      status: true,
      freezeErrorCode: true,
      freezeErrorMessage: true,
      createdAt: true,
      frozenAt: true,
      failedAt: true,
    },
    orderBy: [{ createdAt: "asc" }],
    take: Number(limit),
  });
}

async function run() {
  const duplicateLimitArg = process.argv.find((arg) =>
    arg.startsWith("--duplicate-limit="),
  );
  const setLimitArg = process.argv.find((arg) => arg.startsWith("--set-limit="));
  const duplicateLimit = Number(
    duplicateLimitArg?.split("=")[1] || "100",
  );
  const setLimit = Number(setLimitArg?.split("=")[1] || "200");

  const [nulls, duplicates, nonFrozenSets] = await Promise.all([
    countNullAssignments(),
    findDuplicateSnapshotSetTargetKeys(
      Number.isFinite(duplicateLimit) && duplicateLimit > 0 ? duplicateLimit : 100,
    ),
    findNonFrozenSets(Number.isFinite(setLimit) && setLimit > 0 ? setLimit : 200),
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    checks: {
      remainingNullSnapshotSetId: nulls.nullSnapshotSetId,
      remainingNullTargetKey: nulls.nullTargetKey,
      duplicateSnapshotSetIdTargetKeyCount: duplicates.length,
      nonFrozenSetCount: nonFrozenSets.length,
    },
    duplicateSnapshotSetIdTargetKeyRows: duplicates,
    nonFrozenSets,
  };

  console.log(JSON.stringify(report, null, 2));

  if (
    report.checks.remainingNullSnapshotSetId > 0 ||
    report.checks.remainingNullTargetKey > 0 ||
    report.checks.duplicateSnapshotSetIdTargetKeyCount > 0 ||
    report.checks.nonFrozenSetCount > 0
  ) {
    process.exitCode = 2;
  }
}

run()
  .catch((error) => {
    console.error("Target snapshot backfill verification failed:", error?.message || error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });

