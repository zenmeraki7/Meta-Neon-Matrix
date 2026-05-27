function toPartsMap(parts) {
  return parts.reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
}

function getTimeZoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = toPartsMap(dtf.formatToParts(date));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

export function zonedDateTimeToUtcIso(dateValue, timeValue, timeZone) {
  if (!dateValue || !timeValue || !timeZone) {
    throw new Error("date, time, and timezone are required");
  }

  const [year, month, day] = String(dateValue).split("-").map(Number);
  const [hour, minute] = String(timeValue).split(":").map(Number);

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  let offset = getTimeZoneOffsetMs(utcGuess, timeZone);
  let zonedInstant = new Date(utcGuess.getTime() - offset);
  const refinedOffset = getTimeZoneOffsetMs(zonedInstant, timeZone);
  if (refinedOffset !== offset) {
    zonedInstant = new Date(utcGuess.getTime() - refinedOffset);
  }
  return zonedInstant.toISOString();
}

export function getDateInputInTimezone(timeZone, date = new Date()) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(date);
}
