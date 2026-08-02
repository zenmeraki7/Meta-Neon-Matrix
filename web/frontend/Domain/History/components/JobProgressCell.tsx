import { memo } from "react";
import { useTranslation } from "react-i18next";

export const STATUS_CONFIG = {
  COMPLETED: { tone: "success" },
  PARTIALLY_COMPLETED: { tone: "warning" },
  FAILED: { tone: "critical" },
  RUNNING: { tone: "info" },
  QUEUED: { tone: "warning" },
  PENDING: { tone: "warning" },
  CANCELLED: { tone: "neutral" },
} as const;

export type JobStatus =
  keyof typeof STATUS_CONFIG;

export type JobProgressData = {
  status?: string | null;
  displayStatus?: string | null;
  primaryStatus?: {
    key?: string | null;
  } | null;
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
};

export type JobProgressCellProps = {
  job?: JobProgressData | null;
  processedCount?: number | string | null;
  progressProcessedCount?: number | string | null;
  successCount?: number | string | null;
  totalCount?: number | string | null;
  totalItems?: number | string | null;
  status?: string | null;
};

const STATUS_LABEL_KEYS = {
  COMPLETED: {
    key: "jobStatus.completed",
    defaultValue: "Completed",
  },
  PARTIALLY_COMPLETED: {
    key: "jobStatus.partiallyCompleted",
    defaultValue: "Partially completed",
  },
  FAILED: {
    key: "jobStatus.failed",
    defaultValue: "Failed",
  },
  RUNNING: {
    key: "jobStatus.running",
    defaultValue: "Running",
  },
  QUEUED: {
    key: "jobStatus.queued",
    defaultValue: "Queued",
  },
  PENDING: {
    key: "jobStatus.pending",
    defaultValue: "Waiting to start",
  },
  CANCELLED: {
    key: "jobStatus.cancelled",
    defaultValue: "Cancelled",
  },
} as const satisfies Record<
  JobStatus,
  {
    key: string;
    defaultValue: string;
  }
>;

function toSafeCount(
  value: number | string | null | undefined,
): number {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return 0;
  }

  const count = Number(value);

  if (!Number.isFinite(count) || count < 0) {
    return 0;
  }

  return Math.trunc(count);
}

function hasCount(
  value: number | string | null | undefined,
): boolean {
  return (
    value !== undefined &&
    value !== null &&
    String(value).trim() !== ""
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(100, Math.round(value)),
  );
}

export function normalizeJobStatus(
  jobOrStatus:
    | JobProgressData
    | string
    | null
    | undefined,
): JobStatus {
  const rawStatus =
    typeof jobOrStatus === "string"
      ? jobOrStatus
      : jobOrStatus?.primaryStatus?.key ??
        jobOrStatus?.displayStatus ??
        jobOrStatus?.status;

  const status = String(rawStatus ?? "")
    .trim()
    .toUpperCase();

  if (status.includes("CANCEL")) {
    return "CANCELLED";
  }

  if (
    status === "PARTIAL" ||
    status === "PARTIAL_FAILED" ||
    status === "PARTIALLY_COMPLETED"
  ) {
    return "PARTIALLY_COMPLETED";
  }

  if (status.includes("FAIL")) {
    return "FAILED";
  }

  if (
    status.includes("COMPLETE") ||
    status === "SUCCESS" ||
    status === "PROCESSED"
  ) {
    return "COMPLETED";
  }

  if (
    status === "QUEUED" ||
    status === "PLANNED"
  ) {
    return "QUEUED";
  }

  if (
    status === "PENDING" ||
    status === "WAITING"
  ) {
    return "PENDING";
  }

  return "RUNNING";
}

function getTotalItems(
  job: JobProgressData | null | undefined,
  explicitTotal?: number | string | null,
): number {
  const candidates = [
    explicitTotal,
    job?.totalCount,
    job?.totalItems,
    job?.targetSnapshotCount,
    job?.progressSummary?.total,
  ];

  const firstPositiveCount = candidates
    .map(toSafeCount)
    .find((value) => value > 0);

  return firstPositiveCount ?? 0;
}

function getActualProcessedItems(
  job: JobProgressData | null | undefined,
  explicitProcessed?: number | string | null,
): number {
  const candidates = [
    explicitProcessed,
    job?.progressProcessedCount,
    job?.processedItems,
    job?.successCount,
    job?.progressSummary?.current,
    job?.processedCount,
  ];

  const firstProvidedCount =
    candidates.find(hasCount);

  return toSafeCount(firstProvidedCount);
}

function getDisplayProcessedItems(
  status: JobStatus,
  totalItems: number,
  processedItems: number,
): number {
  if (
    status === "QUEUED" ||
    status === "PENDING"
  ) {
    return 0;
  }

  if (
    status === "COMPLETED" &&
    totalItems > 0
  ) {
    return totalItems;
  }

  if (totalItems <= 0) {
    return processedItems;
  }

  return Math.min(processedItems, totalItems);
}

function calculateProgressFromCounts(
  status: JobStatus,
  totalItems: number,
  processedItems: number,
): number {
  if (status === "COMPLETED") {
    return 100;
  }

  if (
    status === "QUEUED" ||
    status === "PENDING" ||
    totalItems <= 0
  ) {
    return 0;
  }

  return clampPercent(
    (processedItems / Math.max(totalItems, 1)) * 100,
  );
}

export function calculateProgress(job?: JobProgressData | null, explicitProcessed?: number | string | null, explicitTotal?: number | string | null): number {
  const status = normalizeJobStatus(job);
  const totalItems = getTotalItems(
    job,
    explicitTotal,
  );

  const actualProcessed =
    getActualProcessedItems(
      job,
      explicitProcessed,
    );

  const displayProcessed =
    getDisplayProcessedItems(
      status,
      totalItems,
      actualProcessed,
    );

  return calculateProgressFromCounts(
    status,
    totalItems,
    displayProcessed,
  );
}

const JobProgressCell = memo(
  function JobProgressCell({
    job,
    processedCount,
    progressProcessedCount,
    successCount,
    totalCount,
    totalItems,
    status,
  }: JobProgressCellProps) {
    const { t } = useTranslation([
      "history",
      "common",
    ]);

    const normalizedStatus =
      normalizeJobStatus(
        status ??
          job?.primaryStatus?.key ??
          job?.displayStatus ??
          job?.status,
      );

    const total = getTotalItems(
      job,
      totalCount ?? totalItems,
    );

    const actualProcessed =
      getActualProcessedItems(
        job,
        progressProcessedCount ??
          successCount ??
          processedCount,
      );

    const processed =
      getDisplayProcessedItems(
        normalizedStatus,
        total,
        actualProcessed,
      );

    const progress =
      calculateProgressFromCounts(
        normalizedStatus,
        total,
        processed,
      );

    const statusLabel =
      STATUS_LABEL_KEYS[normalizedStatus];

    const translatedStatus = t(
      statusLabel.key,
      {
        defaultValue:
          statusLabel.defaultValue,
      },
    );

    const waiting =
      normalizedStatus === "QUEUED" ||
      normalizedStatus === "PENDING";

    const hasKnownTotal = total > 0;

    const progressDescription = waiting
      ? translatedStatus
      : hasKnownTotal
        ? t("jobProgressCell.processed", {
            defaultValue:
              "{{processedCount}} / {{totalCount}} processed",
            processedCount:
              processed.toLocaleString(),
            totalCount:
              total.toLocaleString(),
          })
        : t(
            "jobProgressCell.processedWithoutTotal",
            {
              defaultValue:
                "{{processedCount}} processed",
              processedCount:
                processed.toLocaleString(),
            },
          );

    return (
      <s-stack gap="small-200">
        <s-grid
          gridTemplateColumns="minmax(0, 1fr) auto"
          gap="small-200"
          alignItems="center"
        >
          <s-text>
            {progressDescription}
          </s-text>

          <s-badge
            tone={
              STATUS_CONFIG[normalizedStatus]
                .tone
            }
          >
            {translatedStatus}
          </s-badge>
        </s-grid>

        {hasKnownTotal ||
        normalizedStatus === "COMPLETED" ? (
          <s-text color="subdued">
            {t(
              "jobProgressCell.percentage",
              {
                defaultValue:
                  "{{progress}}% complete",
                progress,
              },
            )}
          </s-text>
        ) : null}
      </s-stack>
    );
  },
);

JobProgressCell.displayName =
  "JobProgressCell";

export default JobProgressCell;