import crypto from "crypto";
import { RULE_STATUS } from "./automaticProductRuleConstants.js";
import { actorRef } from "./automaticProductRuleGuards.js";
import { normalizeFilterAst } from "../targeting/normalize/filterAstNormalizer.js";

const CONFIG_MUTATION_FIELDS = Object.freeze([
  "title",
  "name",
  "filterAst",
  "conditions",
  "actions",
  "triggerType",
  "scheduleType",
  "scheduleConfig",
  "targetResourceType",
  "applyMode",
  "savedTargetSetId",
  "targetResolutionMode",
  "editOperation",
  "schedule",
  "timezone",
  "initialStatus",
  "status",
  "safetyConfirmation",
  "expectedPreviewFingerprint",
]);

function stableJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

export function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export function hasConfigMutation(commandOrPatch) {
  if (!commandOrPatch || typeof commandOrPatch !== "object") return false;

  return CONFIG_MUTATION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(commandOrPatch, field));
}

export function computeRuleConfigHashFromCommand(command) {
  return sha256Json({
    commandVersion: command.commandVersion ?? 1,
    targetResolutionMode: command.targetResolutionMode,
    filterAst: command.filterAst ?? null,
    normalizedFilterAst: command.filterAst ? normalizeFilterAst(command.filterAst) : null,
    savedTargetSetId: command.savedTargetSetId ?? null,
    triggerType: command.triggerType ?? "EVENT",
    targetResourceType: command.targetResourceType ?? "PRODUCT",
    conditions: command.conditions ?? (command.filterAst ? [command.filterAst] : null),
    actions: command.actions ?? command.editOperation ?? null,
    applyMode: command.applyMode ?? "BULK_EDIT",
    scheduleConfig: command.scheduleConfig ?? command.schedule ?? null,
    timezone: command.timezone ?? null,
  });
}

export function computeRuleConfigHashFromRuleLike(ruleLike) {
  return sha256Json({
    commandVersion: ruleLike.commandVersion ?? 1,
    targetResolutionMode: ruleLike.targetResolutionMode,
    filterAst: ruleLike.normalizedFilterAst ?? ruleLike.filterAst ?? null,
    savedTargetSetId: ruleLike.savedTargetSetId ?? null,
    triggerType: ruleLike.triggerType ?? "EVENT",
    targetResourceType: ruleLike.targetResourceType ?? "PRODUCT",
    conditions: ruleLike.conditions ?? null,
    actions: ruleLike.actions ?? ruleLike.editOperationJson ?? null,
    applyMode: ruleLike.applyMode ?? "BULK_EDIT",
    scheduleConfig: ruleLike.scheduleConfig ?? ruleLike.scheduleJson ?? null,
    timezone: ruleLike.timezone ?? null,
  });
}

export function normalizeRuleCreateData({ shop, actor, command }) {
  const status = command.initialStatus || command.status || RULE_STATUS.DRAFT;
  const ruleConfigHash = computeRuleConfigHashFromCommand(command);
  const now = new Date();

  return {
    shop,
    title: command.title,
    name: command.name ?? command.title,
    status,
    commandVersion: command.commandVersion ?? 1,
    targetResolutionMode: command.targetResolutionMode,
    filterAst: command.filterAst ?? null,
    normalizedFilterAst: command.filterAst ? normalizeFilterAst(command.filterAst) : null,
    savedTargetSetId: command.savedTargetSetId ?? null,
    triggerType: command.triggerType || "EVENT",
    scheduleType: command.scheduleType ?? null,
    timezone: command.timezone ?? null,
    scheduleConfig: command.scheduleConfig ?? command.schedule ?? null,
    scheduleJson: command.scheduleConfig ?? command.schedule ?? null,
    cronExpression: command.cronExpression ?? null,
    intervalMinutes: command.intervalMinutes ?? null,
    targetResourceType: command.targetResourceType || "PRODUCT",
    conditions: command.conditions ?? (command.filterAst ? [command.filterAst] : []),
    actions: command.actions ?? (command.editOperation ? [command.editOperation] : []),
    applyMode: command.applyMode || "BULK_EDIT",
    editOperationJson: command.editOperation ?? command.actions ?? null,
    safetyConfirmationJson: command.safetyConfirmation ?? null,
    expectedPreviewFingerprint: command.expectedPreviewFingerprint ?? null,
    ruleConfigHash,
    revision: 1,
    createdByActorId: actorRef(actor),
    updatedByActorId: actorRef(actor),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    schedulerDisabledAt: status === RULE_STATUS.ACTIVE ? null : now,
  };
}

export function buildUpdateDataFromPatch({ existingRule, patchCommand, actor }) {
  const now = new Date();

  const allowedPatchKeys = [
    "title",
    "name",
    "status",
    "filterAst",
    "savedTargetSetId",
    "targetResolutionMode",
    "triggerType",
    "scheduleType",
    "scheduleConfig",
    "schedule",
    "targetResourceType",
    "conditions",
    "actions",
    "editOperation",
    "applyMode",
    "timezone",
    "safetyConfirmation",
    "expectedPreviewFingerprint",
  ];

  const hasAllowedUpdates = allowedPatchKeys.some(
    (key) => patchCommand[key] !== undefined
  );

  if (!hasAllowedUpdates) {
    return {
      updatedAt: now,
      updatedByActorId: actorRef(actor),
    };
  }

  const nextRuleLike = {
    ...existingRule,
    commandVersion: existingRule.commandVersion ?? 1,
    title: patchCommand.title !== undefined ? patchCommand.title : existingRule.title,
    name: patchCommand.name !== undefined ? patchCommand.name : (patchCommand.title !== undefined ? patchCommand.title : existingRule.name),
    status: patchCommand.status !== undefined ? patchCommand.status : existingRule.status,
    triggerType: patchCommand.triggerType !== undefined ? patchCommand.triggerType : existingRule.triggerType,
    scheduleType: patchCommand.scheduleType !== undefined ? patchCommand.scheduleType : existingRule.scheduleType,
    scheduleConfig: patchCommand.scheduleConfig !== undefined ? patchCommand.scheduleConfig : (patchCommand.schedule !== undefined ? patchCommand.schedule : existingRule.scheduleConfig),
    scheduleJson: patchCommand.scheduleConfig !== undefined ? patchCommand.scheduleConfig : (patchCommand.schedule !== undefined ? patchCommand.schedule : existingRule.scheduleJson),
    targetResourceType: patchCommand.targetResourceType !== undefined ? patchCommand.targetResourceType : existingRule.targetResourceType,
    conditions: patchCommand.conditions !== undefined ? patchCommand.conditions : existingRule.conditions,
    actions: patchCommand.actions !== undefined ? patchCommand.actions : (patchCommand.editOperation !== undefined ? patchCommand.editOperation : existingRule.actions),
    applyMode: patchCommand.applyMode !== undefined ? patchCommand.applyMode : existingRule.applyMode,
    targetResolutionMode: patchCommand.targetResolutionMode ?? existingRule.targetResolutionMode,
    filterAst: patchCommand.filterAst !== undefined ? patchCommand.filterAst : existingRule.filterAst,
    normalizedFilterAst: patchCommand.filterAst !== undefined
      ? (patchCommand.filterAst ? normalizeFilterAst(patchCommand.filterAst) : null)
      : existingRule.normalizedFilterAst,
    savedTargetSetId: patchCommand.savedTargetSetId !== undefined ? patchCommand.savedTargetSetId : existingRule.savedTargetSetId,
    editOperationJson: patchCommand.actions !== undefined ? patchCommand.actions : (patchCommand.editOperation !== undefined ? patchCommand.editOperation : existingRule.editOperationJson),
    timezone: patchCommand.timezone !== undefined ? patchCommand.timezone : existingRule.timezone,
  };

  const data = {
    updatedAt: now,
    updatedByActorId: actorRef(actor),
    revision: {
      increment: 1,
    },
    ruleConfigHash: computeRuleConfigHashFromRuleLike(nextRuleLike),
  };

  if (patchCommand.title !== undefined) data.title = patchCommand.title;
  if (patchCommand.name !== undefined) data.name = patchCommand.name;
  if (patchCommand.status !== undefined) {
    data.status = patchCommand.status;
    data.schedulerDisabledAt = patchCommand.status === RULE_STATUS.ACTIVE ? null : now;
  }
  if (patchCommand.filterAst !== undefined) {
    data.filterAst = patchCommand.filterAst;
    data.normalizedFilterAst = patchCommand.filterAst
      ? normalizeFilterAst(patchCommand.filterAst)
      : null;
  }
  if (patchCommand.actions !== undefined) {
    data.actions = patchCommand.actions;
    data.editOperationJson = patchCommand.actions;
  } else if (patchCommand.editOperation !== undefined) {
    data.editOperationJson = patchCommand.editOperation;
  }
  if (patchCommand.conditions !== undefined) data.conditions = patchCommand.conditions;
  if (patchCommand.triggerType !== undefined) data.triggerType = patchCommand.triggerType;
  if (patchCommand.scheduleType !== undefined) data.scheduleType = patchCommand.scheduleType;
  if (patchCommand.scheduleConfig !== undefined) {
    data.scheduleConfig = patchCommand.scheduleConfig;
    data.scheduleJson = patchCommand.scheduleConfig;
  } else if (patchCommand.schedule !== undefined) {
    data.scheduleJson = patchCommand.schedule;
  }
  if (patchCommand.targetResourceType !== undefined) {
    data.targetResourceType = patchCommand.targetResourceType;
  }
  if (patchCommand.applyMode !== undefined) data.applyMode = patchCommand.applyMode;
  if (patchCommand.savedTargetSetId !== undefined) data.savedTargetSetId = patchCommand.savedTargetSetId;
  if (patchCommand.targetResolutionMode !== undefined) data.targetResolutionMode = patchCommand.targetResolutionMode;
  if (patchCommand.timezone !== undefined) data.timezone = patchCommand.timezone;
  if (patchCommand.safetyConfirmation !== undefined) data.safetyConfirmationJson = patchCommand.safetyConfirmation;
  if (patchCommand.expectedPreviewFingerprint !== undefined) data.expectedPreviewFingerprint = patchCommand.expectedPreviewFingerprint;

  return data;
}

export async function createAuditEvent({ tx, shop, actor, action, resourceType, resourceId, metadata }) {
  if (!tx.auditEvent) {
    return null;
  }

  return tx.auditEvent.create({
    data: {
      shop,
      actorJson: actor,
      action,
      resourceType,
      resourceId,
      metadataJson: metadata ?? {},
      createdAt: new Date(),
    },
  });
}
