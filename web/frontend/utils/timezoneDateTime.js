function toPartsMap(parts) {
  return parts.reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
}

export function isValidTimeZone(timeZone) {
  if (!timeZone) return false;

  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parseDateParts(dateValue) {
  const text = String(dateValue || "").trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);

  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      format: "yyyy-MM-dd",
    };
  }

  match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text);
  if (match) {
    return {
      year: Number(match[3]),
      month: Number(match[2]),
      day: Number(match[1]),
      format: "dd-MM-yyyy",
    };
  }

  return null;
}

function isValidCalendarDate({ year, month, day }) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return (
    utcDate.getUTCFullYear() === year &&
    utcDate.getUTCMonth() === month - 1 &&
    utcDate.getUTCDate() === day
  );
}

function parseTimeParts(timeValue) {
  const text = String(timeValue || "").trim();
  let match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);

  if (match) {
    return {
      hour: Number(match[1]),
      minute: Number(match[2]),
      format: "HH:mm",
    };
  }

  match = /^(0?[1-9]|1[0-2]):([0-5]\d)\s*([AaPp][Mm])$/.exec(text);
  if (!match) return null;

  const hour12 = Number(match[1]);
  const meridiem = match[3].toUpperCase();
  return {
    hour:
      meridiem === "AM"
        ? hour12 % 12
        : hour12 === 12
          ? 12
          : hour12 + 12,
    minute: Number(match[2]),
    format: "hh:mm a",
  };
}

export function parseScheduleDateTimeParts(dateValue, timeValue) {
  const date = parseDateParts(dateValue);
  const time = parseTimeParts(timeValue);

  if (!date || !time || !isValidCalendarDate(date)) {
    return null;
  }

  return {
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute,
    dateFormat: date.format,
    timeFormat: time.format,
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
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

  if (!isValidTimeZone(timeZone)) {
    throw new Error("timezone is unavailable or invalid");
  }

  const parts = parseScheduleDateTimeParts(dateValue, timeValue);
  if (!parts) {
    throw new Error("date and time must be valid schedule values");
  }

  const { year, month, day, hour, minute } = parts;

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  let offset = getTimeZoneOffsetMs(utcGuess, timeZone);
  let zonedInstant = new Date(utcGuess.getTime() - offset);
  const refinedOffset = getTimeZoneOffsetMs(zonedInstant, timeZone);
  if (refinedOffset !== offset) {
    zonedInstant = new Date(utcGuess.getTime() - refinedOffset);
  }

  const roundTripParts = toPartsMap(new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(zonedInstant));

  if (
    Number(roundTripParts.year) !== year ||
    Number(roundTripParts.month) !== month ||
    Number(roundTripParts.day) !== day ||
    Number(roundTripParts.hour) !== hour ||
    Number(roundTripParts.minute) !== minute
  ) {
    throw new Error("date and time do not exist in the selected timezone");
  }

  return zonedInstant.toISOString();
}

export function getScheduleDateTimeValidation({
  date,
  time,
  timeZone,
  now = new Date(),
}) {
  if (!date) return { valid: false, code: "MISSING_DATE" };
  if (!time) return { valid: false, code: "MISSING_TIME" };
  if (!timeZone) return { valid: false, code: "MISSING_TIMEZONE" };
  if (!isValidTimeZone(timeZone)) {
    return { valid: false, code: "INVALID_TIMEZONE" };
  }

  try {
    const utcIso = zonedDateTimeToUtcIso(date, time, timeZone);
    const utcDate = new Date(utcIso);
    const nowDate = now instanceof Date ? now : new Date(now);

    if (!Number.isFinite(utcDate.getTime())) {
      return { valid: false, code: "INVALID_DATETIME" };
    }

    if (utcDate.getTime() <= nowDate.getTime()) {
      return { valid: false, code: "PAST_DATETIME", utcIso };
    }

    return { valid: true, code: "OK", utcIso };
  } catch {
    return { valid: false, code: "INVALID_DATETIME" };
  }
}

export function getDateInputInTimezone(timeZone, date = new Date()) {
  if (!isValidTimeZone(timeZone)) {
    throw new Error("timezone is unavailable or invalid");
  }

  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(date);
}
