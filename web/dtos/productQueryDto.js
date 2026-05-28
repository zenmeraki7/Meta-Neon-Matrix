function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

export function toProductQueryResponseDto(result) {
  return {
    success: true,
    data: result || {},
  };
}

export function toBulkEditStatusDto(result) {
  return {
    success: true,
    data: result || {},
  };
}

export function toProductOptionListDto(result) {
  const data = safeArray(result);
  return {
    success: true,
    data: data.map((value) => ({
      value: safeString(value, ""),
      label: safeString(value, ""),
    })),
    meta: { count: data.length },
  };
}

export function toFilterRegistryDto(result) {
  return {
    success: true,
    data: {
      versions: result?.versions || null,
      fields: safeArray(result?.fields),
    },
  };
}
