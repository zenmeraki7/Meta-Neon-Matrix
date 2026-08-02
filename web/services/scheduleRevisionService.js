import crypto from "node:crypto";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stable(value[key]);
      return result;
    }, {});
  }
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function buildScheduleRevisionSnapshot(definition, ownerType) {
  const filter = {
    filterAst: definition.filterAst ?? null,
    normalizedFilterAst: definition.normalizedFilterAst ?? null,
    normalizedFilterHash: definition.normalizedFilterHash ?? null,
    rawFilterInput: definition.rawFilterInput ?? [],
    targetGranularity: definition.targetGranularity ?? "PRODUCT",
    targetingSnapshotMeta: definition.targetingSnapshotMeta ?? null,
  };
  const selectedFields = ownerType === "SCHEDULED_EXPORT"
    ? definition.selectedFieldKeys ?? []
    : [];
  const rulesActions = ownerType === "RECURRING_EDIT"
    ? { rules: definition.rules ?? [] }
    : { selectedFieldKeys: selectedFields };
  const schedulePolicy = {
    scheduleType: definition.scheduleType,
    timezone: definition.timezone,
    scheduleConfig: definition.scheduleConfig ?? null,
    cronExpression: definition.cronExpression ?? null,
    intervalMinutes: definition.intervalMinutes ?? null,
    startAt: definition.startAt ?? null,
    endAt: definition.endAt ?? null,
    missedRunPolicy: definition.missedRunPolicy ?? "SKIP",
  };
  const snapshot = {
    ownerType,
    title: definition.title,
    status: definition.status,
    filter,
    selectedFields,
    rulesActions,
    schedulePolicy,
    generatedFilename: definition.generatedFilename ?? null,
    targetFreezeMode: definition.targetFreezeMode ?? null,
    targetingCompilerVersion: definition.targetingCompilerVersion ?? null,
    fieldRegistryVersion: definition.fieldRegistryVersion ?? null,
    operatorRegistryVersion: definition.operatorRegistryVersion ?? null,
  };
  return {
    definitionSnapshot: stable(snapshot),
    configurationHash: hash(snapshot),
    filterSnapshotHash: hash(filter),
    selectedFieldsSnapshotHash: hash(selectedFields),
    rulesActionsSnapshotHash: hash(rulesActions),
    schedulePolicySnapshotHash: hash(schedulePolicy),
  };
}

export async function persistRecurringEditRevision({ tx, definition }) {
  const hashes = buildScheduleRevisionSnapshot(definition, "RECURRING_EDIT");
  await tx.recurringEditRevision.create({
    data: { shop: definition.shop, recurringEditId: definition.id, revision: definition.revision, ...hashes },
  });
  await tx.recurringEditScheduleState.upsert({
    where: { shop_recurringEditId: { shop: definition.shop, recurringEditId: definition.id } },
    create: {
      shop: definition.shop, recurringEditId: definition.id, definitionRevision: definition.revision,
      nextRunAt: definition.nextRunAt, disabledAt: definition.status === "ACTIVE" ? null : new Date(),
      missedRunPolicy: definition.missedRunPolicy ?? "SKIP",
    },
    update: {
      definitionRevision: definition.revision, scheduleVersion: { increment: 1 }, nextRunAt: definition.nextRunAt,
      claimedAt: null, claimOwner: null, claimExpiresAt: null, fencingToken: { increment: 1 },
      disabledAt: definition.status === "ACTIVE" ? null : new Date(), missedRunPolicy: definition.missedRunPolicy ?? "SKIP",
    },
  });
  return hashes;
}

export async function persistScheduledExportRevision({ tx, definition }) {
  const hashes = buildScheduleRevisionSnapshot(definition, "SCHEDULED_EXPORT");
  await tx.scheduledExportRevision.create({
    data: { shop: definition.shop, scheduledExportId: definition.id, revision: definition.revision, ...hashes },
  });
  await tx.scheduledExportScheduleState.upsert({
    where: { shop_scheduledExportId: { shop: definition.shop, scheduledExportId: definition.id } },
    create: {
      shop: definition.shop, scheduledExportId: definition.id, definitionRevision: definition.revision,
      nextRunAt: definition.nextRunAt, disabledAt: definition.status === "ACTIVE" ? null : new Date(),
      missedRunPolicy: definition.missedRunPolicy ?? "SKIP",
    },
    update: {
      definitionRevision: definition.revision, scheduleVersion: { increment: 1 }, nextRunAt: definition.nextRunAt,
      claimedAt: null, claimOwner: null, claimExpiresAt: null, fencingToken: { increment: 1 },
      disabledAt: definition.status === "ACTIVE" ? null : new Date(), missedRunPolicy: definition.missedRunPolicy ?? "SKIP",
    },
  });
  return hashes;
}
