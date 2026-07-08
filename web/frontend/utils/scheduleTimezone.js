const TIMEZONE_ALIASES = Object.freeze({
  "Asia/Calcutta": "Asia/Kolkata",
});

export function normalizeScheduleTimezone(timezone) {
  const normalized = typeof timezone === "string" ? timezone.trim() : "";
  const canonical = TIMEZONE_ALIASES[normalized] || normalized;

  if (!canonical) return null;

  try {
    Intl.DateTimeFormat(undefined, { timeZone: canonical });
    return canonical;
  } catch {
    return null;
  }
}

export function getBrowserScheduleTimezone() {
  if (typeof window === "undefined" || typeof Intl === "undefined") {
    return null;
  }

  try {
    return normalizeScheduleTimezone(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  } catch {
    return null;
  }
}
