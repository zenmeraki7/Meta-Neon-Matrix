import {
  buildPlanCapabilities,
  DEFAULT_BILLING_URL,
  SCHEDULED_EDITS_FEATURE,
  SCHEDULED_EDITS_UPGRADE_MESSAGE,
} from "./planCapabilities.js";

export {
  SCHEDULED_EDITS_FEATURE,
  SCHEDULED_EDITS_UPGRADE_MESSAGE,
};

export function canUseScheduledEdits(subscription = {}) {
  return buildPlanCapabilities(subscription).canScheduleEdits;
}

export function getScheduleEditBillingUrl() {
  return DEFAULT_BILLING_URL;
}

export function buildScheduleEditCapability(subscription = {}) {
  return buildPlanCapabilities(subscription);
}
