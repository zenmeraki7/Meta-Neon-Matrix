import crypto from "crypto";
import { RULE_STATUS } from "./automaticProductRuleConstants.js";
import { actorRef } from "./automaticProductRuleGuards.js";
import { normalizeFilterAst } from "../targeting/normalize/filterAstNormalizer.js";

const CONFIG_MUTATION_FIELDS = Object.freeze([
  "name",
  "filterAst",
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
    editOperation: command.editOperation,
    schedule: command.schedule ?? null,
    timezone: command.timezone ?? null,
  });
}

export function computeRuleConfigHashFromRuleLike(ruleLike) {
  return sha256Json({
    commandVersion: ruleLike.commandVersion ?? 1,
    targetResolutionMode: ruleLike.targetResolutionMode,
    filterAst: ruleLike.normalizedFilterAst ?? ruleLike.filterAst ?? null,
    savedTargetSetId: ruleLike.savedTargetSetId ?? null,
    editOperation: ruleLike.editOperationJson ?? ruleLike.editOperation ?? null,
    schedule: ruleLike.scheduleJson ?? ruleLike.schedule ?? null,
    timezone: ruleLike.timezone ?? null,
  });
}

export function normalizeRuleCreateData({ shop, actor, command }) {
  const status = command.initialStatus || RULE_STATUS.DRAFT;
  const ruleConfigHash = computeRuleConfigHashFromCommand(command);
  const now = new Date();

  return {
    shop,
    name: command.name ?? command.title,
    status,
    commandVersion: command.commandVersion ?? 1,
    targetResolutionMode: command.targetResolutionMode,
    filterAst: command.filterAst ?? null,
    savedTargetSetId: command.savedTargetSetId ?? null,
    editOperationJson: command.editOperation,
    scheduleJson: command.schedule ?? null,
    timezone: command.timezone ?? null,
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

  const nextRuleLike = {
    ...existingRule,
    commandVersion: existingRule.commandVersion ?? 1,
    targetResolutionMode: patchCommand.targetResolutionMode ?? existingRule.targetResolutionMode,
    filterAst: patchCommand.filterAst !== undefined ? patchCommand.filterAst : existingRule.filterAst,
    savedTargetSetId: patchCommand.savedTargetSetId !== undefined ? patchCommand.savedTargetSetId : existingRule.savedTargetSetId,
    editOperationJson: patchCommand.editOperation !== undefined ? patchCommand.editOperation : existingRule.editOperationJson,
    scheduleJson: patchCommand.schedule !== undefined ? patchCommand.schedule : existingRule.scheduleJson,
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

  if (patchCommand.name !== undefined) data.name = patchCommand.name;
  if (patchCommand.status !== undefined) {
    data.status = patchCommand.status;
    data.schedulerDisabledAt = patchCommand.status === RULE_STATUS.ACTIVE ? null : now;
  }
  if (patchCommand.filterAst !== undefined) data.filterAst = patchCommand.filterAst;
  if (patchCommand.filterAst !== undefined) {
    data.normalizedFilterAst = patchCommand.filterAst
      ? normalizeFilterAst(patchCommand.filterAst)
      : null;
  }
  if (patchCommand.savedTargetSetId !== undefined) data.savedTargetSetId = patchCommand.savedTargetSetId;
  if (patchCommand.targetResolutionMode !== undefined) data.targetResolutionMode = patchCommand.targetResolutionMode;
  if (patchCommand.editOperation !== undefined) data.editOperationJson = patchCommand.editOperation;
  if (patchCommand.schedule !== undefined) data.scheduleJson = patchCommand.schedule;
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
