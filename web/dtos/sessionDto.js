export function toSessionChangeResultDto(result = {}) {
  return {
    success: true,
    staged: Number(result?.staged || 0),
  };
}

export function toSessionCommitResultDto(result = {}) {
  return {
    success: true,
    sessionId: result?.sessionId ? String(result.sessionId) : null,
    changeCount: Number(result?.changeCount || 0),
    jobId: result?.jobId ? String(result.jobId) : null,
  };
}

