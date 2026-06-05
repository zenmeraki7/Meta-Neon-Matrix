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
    data: data.map((item) => {
      if (item && typeof item === "object") {
        const value = safeString(item.value ?? item.title ?? item.label ?? item.name ?? item.id, "");
        const label = safeString(item.label ?? item.title ?? item.value ?? item.name ?? item.id, value);
        return { value, label };
      }

      return {
        value: safeString(item, ""),
        label: safeString(item, ""),
      };
    }),
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
