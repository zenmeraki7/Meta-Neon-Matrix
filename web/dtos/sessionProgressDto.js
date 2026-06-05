export function toSessionProgressEventDto(session = {}) {
  return {
    status: session.status,
    changeCount: Number(session.change_count || 0),
    writtenCount: Number(session.written_count || 0),
    errorCount: Number(session.error_count || 0),
  };
}

