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
  const data = safeArray(result)
    .map((item) => {
      if (item && typeof item === "object") {
        const value = safeString(
          item.value ?? item.title ?? item.name ?? item.label ?? item.id,
          "",
        );
        const label = safeString(
          item.label ?? item.title ?? item.name ?? item.value ?? item.id,
          value,
        );

        return value ? { value, label } : null;
      }

      const value = safeString(item, "");
      return value ? { value, label: value } : null;
    })
    .filter(Boolean);

  return {
    success: true,
    data,
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
