import React from "react";
import PropTypes from "prop-types";
import { Badge } from "@shopify/polaris";

const TONE_BY_STATUS = {
  QUEUED: "attention",
  TARGET_FREEZING: "info",
  TARGET_FROZEN: "info",
  EXECUTING: "info",
  WAITING_FOR_SHOPIFY_SLOT: "warning",
  SHOPIFY_RUNNING: "info",
  SHOPIFY_COMPLETED: "success",
  INGESTING_RESULTS: "info",
  VERIFYING: "info",
  MIRROR_UPDATING: "info",
  COMPLETED: "success",
  SUCCESS: "success",
  SUCCEEDED: "success",
  VERIFIED: "success",
  PARTIAL_FAILED: "warning",
  FAILED: "critical",
  CANCELLED: "critical",
  UNDO_RUNNING: "info",
  UNDO_COMPLETED: "success",
  ACTIVE: "success",
  INACTIVE: "warning",
  PAUSED: "warning",
  EXPIRED: "attention",
  PENDING: "attention",
  PROCESSING: "info",
};

function toUpper(status) {
  return String(status || "").trim().toUpperCase();
}

function render(status, label) {
  const key = toUpper(status);
  return <Badge tone={TONE_BY_STATUS[key] || "attention"}>{label || key || "UNKNOWN"}</Badge>;
}

export function operationStatusBadge(status, label) {
  return render(status, label);
}

export function importStatusBadge(status, label) {
  return render(status, label);
}

export function exportStatusBadge(status, label) {
  return render(status, label);
}

export function recurringStatusBadge(status, label) {
  return render(status, label);
}

export default function StatusBadge({ status, label }) {
  return render(status, label);
}

StatusBadge.propTypes = {
  status: PropTypes.string,
  label: PropTypes.string,
};

