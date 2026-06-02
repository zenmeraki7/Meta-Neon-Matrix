import { db } from "../repositories/repositoryDb.js";

export async function recordDeadLetterJob({
  shop = null,
  queueName,
  jobName = null,
  jobId = null,
  payload = null,
  error = null,
  attempts = 0,
  recoverable = false,
  lastErrorCode = null,
}) {
  return db.deadLetterJob.create({
    data: {
      shop,
      queueName,
      jobName,
      jobId: jobId ? String(jobId) : null,
      payload: payload || null,
      error: JSON.stringify({
        message: error?.message || String(error || ""),
        code: lastErrorCode || error?.code || null,
        recoverable,
      }),
      attempts: Number(attempts || 0),
      resolution: recoverable ? "RECOVERABLE" : "UNRECOVERABLE",
    },
  });
}


