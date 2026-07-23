import React, { memo } from "react";
import { Box, BlockStack, Text } from "@shopify/polaris";
import type { BoxProps } from "@shopify/polaris";
import { useTranslation } from "react-i18next";

// Box's typed `role` union in this codebase doesn't include "progressbar",
// even though it's forwarded to the DOM fine at runtime. Cast just this value
// rather than widening Box's props with `any`.
const PROGRESSBAR_ROLE = "progressbar" as unknown as BoxProps["role"];

export const STATUS_CONFIG = {
  COMPLETED: { tone: "success", color: "green" },
  FAILED: { tone: "critical", color: "red" },
  RUNNING: { tone: "info", color: "blue" },
  QUEUED: { tone: "warning", color: "yellow" },
  PENDING: { tone: "warning", color: "yellow" },
  CANCELLED: { tone: "subdued", color: "gray" },
} as const;

type JobStatus = keyof typeof STATUS_CONFIG;

type JobProgressCellProps = {
  job?: {
    status?: string | null;
    displayStatus?: string | null;
    primaryStatus?: { key?: string | null } | null;
    processedItems?: number | string | null;
    progressProcessedCount?: number | string | null;
    processedCount?: number | string | null;
    successCount?: number | string | null;
    totalItems?: number | string | null;
    totalCount?: number | string | null;
    targetSnapshotCount?: number | string | null;
    progressSummary?: {
      current?: number | string | null;
      total?: number | string | null;
    } | null;
  } | null;
  processedCount?: number | string | null;
  progressProcessedCount?: number | string | null;
  successCount?: number | string | null;
  totalCount?: number | string | null;
  totalItems?: number | string | null;
  status?: string | null;
};

const STATUS_LABEL_KEYS: Record<JobStatus, { key: string; defaultValue: string }> = {
  COMPLETED: { key: "jobStatus.completed", defaultValue: "Completed" },
  FAILED: { key: "jobStatus.failed", defaultValue: "Failed" },
  RUNNING: { key: "jobStatus.running", defaultValue: "Running" },
  QUEUED: { key: "jobStatus.queued", defaultValue: "Queued" },
  PENDING: { key: "jobStatus.pending", defaultValue: "Waiting to start" },
  CANCELLED: { key: "jobStatus.cancelled", defaultValue: "Cancelled" },
};

// Polaris 13 background tokens standing in for the original hex values.
// (Box only accepts design-token backgrounds, not arbitrary hex, so this is
// the closest same-hue mapping — flag if you need the exact original hex.)
const PROGRESS_COLOR_TOKEN: Record<
  (typeof STATUS_CONFIG)[JobStatus]["color"],
  NonNullable<BoxProps["background"]>
> = {
  green: "bg-fill-success",
  red: "bg-fill-critical",
  blue: "bg-fill-info",
  yellow: "bg-fill-warning",
  gray: "bg-fill-disabled",
};

function toSafeCount(value: number | string | null | undefined) {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count < 0) return 0;
  return count;
}

function hasCount(value: number | string | null | undefined) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function normalizeJobStatus(
  jobOrStatus: JobProgressCellProps["job"] | string | null | undefined,
): JobStatus {
  const raw =
    typeof jobOrStatus === "string"
      ? jobOrStatus
      : jobOrStatus?.primaryStatus?.key || jobOrStatus?.displayStatus || jobOrStatus?.status;
  const status = String(raw || "").trim().toUpperCase();
  if (status.includes("CANCEL")) return "CANCELLED";
  if (status.includes("FAIL") || status === "PARTIAL" || status === "PARTIAL_FAILED") return "FAILED";
  if (status.includes("COMPLETE") || status === "SUCCESS") return "COMPLETED";
  if (status === "QUEUED" || status === "PLANNED") return "QUEUED";
  if (status === "PENDING") return "PENDING";
  return "RUNNING";
}

function getTotalItems(job: JobProgressCellProps["job"], explicitTotal?: number | string | null) {
  const candidates = [
    explicitTotal,
    job?.totalCount,
    job?.totalItems,
    job?.targetSnapshotCount,
    job?.progressSummary?.total,
  ];
  const positiveCount = candidates.map(toSafeCount).find((value) => value > 0);
  return positiveCount ?? 0;
}

function getActualProcessedItems(
  job: JobProgressCellProps["job"],
  explicitProcessed?: number | string | null,
) {
  const candidates = [
    explicitProcessed,
    job?.progressProcessedCount,
    job?.processedItems,
    job?.successCount,
    job?.progressSummary?.current,
    job?.processedCount,
  ];
  const firstProvidedCount = candidates.find(hasCount);
  return toSafeCount(firstProvidedCount);
}

function getDisplayProcessedItems(
  job: JobProgressCellProps["job"],
  status: JobStatus,
  totalItems: number,
  processedItems: number,
) {
  if (status === "COMPLETED") return totalItems;
  if (status === "QUEUED" || status === "PENDING") return 0;
  return Math.min(processedItems, totalItems || processedItems);
}

export function calculateProgress(job: JobProgressCellProps["job"]) {
  const status = normalizeJobStatus(job);
  const totalItems = getTotalItems(job);
  if (status === "COMPLETED") return 100;
  if (status === "QUEUED" || status === "PENDING") return 0;
  const processedItems = getActualProcessedItems(job);
  if (totalItems <= 0) return 0;
  return clampPercent((processedItems / Math.max(totalItems, 1)) * 100);
}

const JobProgressCell = memo(function JobProgressCell({
  job,
  processedCount,
  progressProcessedCount,
  successCount,
  totalCount,
  totalItems,
  status,
}: JobProgressCellProps) {
  const { t } = useTranslation(["history", "common"]);

  const progressJob = {
    ...(job || {}),
    status: status ?? job?.status,
    processedItems: progressProcessedCount ?? successCount ?? job?.progressProcessedCount ?? job?.processedItems,
    processedCount: processedCount ?? job?.processedCount,
    successCount: successCount ?? job?.successCount,
    totalItems: totalItems ?? totalCount ?? job?.totalItems,
    totalCount: totalCount ?? job?.totalCount,
  };

  const normalizedStatus = normalizeJobStatus(progressJob);
  const total = getTotalItems(progressJob, totalCount ?? totalItems);
  const processed = getDisplayProcessedItems(
    progressJob,
    normalizedStatus,
    total,
    getActualProcessedItems(progressJob, progressProcessedCount ?? successCount ?? processedCount),
  );
  const progress = calculateProgress(progressJob);
  const colorToken = PROGRESS_COLOR_TOKEN[STATUS_CONFIG[normalizedStatus].color];
  const statusLabel = STATUS_LABEL_KEYS[normalizedStatus];
  const showQueuedText = normalizedStatus === "QUEUED" || normalizedStatus === "PENDING";
  const showFailureText = normalizedStatus === "FAILED";

  return (
    <BlockStack gap="100">
      <Text as="span" variant="bodySm">
        {showQueuedText
          ? t(statusLabel.key, { defaultValue: statusLabel.defaultValue })
          : t("jobProgressCell.processed", {
              defaultValue: "{{processedCount}} / {{totalCount}} processed",
              processedCount: processed.toLocaleString(),
              totalCount: total.toLocaleString(),
            })}
      </Text>

      <Box
        aria-label={t("jobProgressCell.progressLabel", {
          defaultValue: "{{progress}}% complete",
          progress,
        })}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress}
        role={PROGRESSBAR_ROLE}
        background="bg-fill-disabled"
        borderRadius="100"
        minHeight="10px"
        overflowX="hidden"
        overflowY="hidden"
        width="100%"
      >
        <Box background={colorToken} minHeight="10px" width={`${progress}%`} />
      </Box>

      {showFailureText ? (
        <Text as="span" variant="bodySm" tone="critical">
          {t(statusLabel.key, { defaultValue: statusLabel.defaultValue })}
        </Text>
      ) : null}
    </BlockStack>
  );
});

JobProgressCell.displayName = "JobProgressCell";

export default JobProgressCell;
