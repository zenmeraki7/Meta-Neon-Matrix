export const EXPORT_JOB_LIST_SELECT = Object.freeze({
  id: true,
  filename: true,
  fileUrl: true,
  createdAt: true,
  completedAt: true,
  type: true,
  targetGranularity: true,
  status: true,
  statusNormalized: true,
  executionState: true,
  executionStateNormalized: true,
  totalItems: true,
  targetSnapshotCount: true,
  durationMs: true,
  error: true,
});

export const EXPORT_JOB_DETAIL_SELECT = Object.freeze({
  ...EXPORT_JOB_LIST_SELECT,
  updatedAt: true,
  startedAt: true,
  fields: true,
});

export function deriveExportProcessedCount(job = {}) {
  return job.completedAt ? Number(job.totalItems || 0) : 0;
}

export function deriveExportProgressPercent(job = {}) {
  const status = String(job.statusNormalized || job.status || "").toUpperCase();
  const executionState = String(
    job.executionStateNormalized || job.executionState || "",
  ).toUpperCase();

  if (status === "COMPLETED" || executionState === "COMPLETED" || job.completedAt) {
    return 100;
  }
  if (status === "PROCESSING" || executionState === "RUNNING") {
    return 60;
  }
  if (status === "FAILED" || executionState === "FAILED") {
    return 0;
  }
  return 5;
}

export function withDerivedExportProgress(job) {
  if (!job) return job;
  return {
    ...job,
    processedCount: deriveExportProcessedCount(job),
    progressPercent: deriveExportProgressPercent(job),
  };
}
