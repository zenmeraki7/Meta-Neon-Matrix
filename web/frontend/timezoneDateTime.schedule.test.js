import test from "node:test";
import assert from "node:assert/strict";

import {
  getScheduleDateTimeValidation,
  zonedDateTimeToUtcIso,
} from "./utils/timezoneDateTime.js";

test("future schedule in America/New_York passes and returns UTC ISO", () => {
  const validation = getScheduleDateTimeValidation({
    date: "26-06-2026",
    time: "02:03 AM",
    timeZone: "America/New_York",
    now: new Date("2026-06-25T00:00:00.000Z"),
  });

  assert.equal(validation.valid, true);
  assert.equal(validation.utcIso, "2026-06-26T06:03:00.000Z");
});

test("past schedule in America/New_York fails", () => {
  const validation = getScheduleDateTimeValidation({
    date: "25-06-2026",
    time: "02:00 AM",
    timeZone: "America/New_York",
    now: new Date("2026-06-25T07:00:00.000Z"),
  });

  assert.equal(validation.valid, false);
  assert.equal(validation.code, "PAST_DATETIME");
});

test("DD-MM-YYYY parsing is explicit and does not become MM-DD-YYYY", () => {
  assert.equal(
    zonedDateTimeToUtcIso("05-07-2026", "02:03 AM", "America/New_York"),
    "2026-07-05T06:03:00.000Z",
  );
});

test("browser or process timezone does not affect shop-time conversion", () => {
  const originalTimezone = process.env.TZ;

  try {
    process.env.TZ = "Asia/Kolkata";
    const kolkataHost = zonedDateTimeToUtcIso(
      "2026-06-26",
      "02:03",
      "America/New_York",
    );

    process.env.TZ = "America/Los_Angeles";
    const losAngelesHost = zonedDateTimeToUtcIso(
      "2026-06-26",
      "02:03",
      "America/New_York",
    );

    assert.equal(kolkataHost, "2026-06-26T06:03:00.000Z");
    assert.equal(losAngelesHost, kolkataHost);
  } finally {
    if (originalTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimezone;
    }
  }
});

test("scheduledAt payload value is normalized UTC ISO", () => {
  const scheduledAt = zonedDateTimeToUtcIso(
    "20-05-2027",
    "02:03 AM",
    "America/New_York",
  );

  assert.equal(scheduledAt, "2027-05-20T06:03:00.000Z");
  assert.match(scheduledAt, /Z$/);
});
