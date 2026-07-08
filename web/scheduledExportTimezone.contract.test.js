import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  getBrowserScheduleTimezone,
  normalizeScheduleTimezone,
} from "./frontend/utils/scheduleTimezone.js";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

function withMockBrowserTimezone(timeZone, fn) {
  const originalWindow = globalThis.window;
  const OriginalDateTimeFormat = Intl.DateTimeFormat;

  globalThis.window = {};
  Intl.DateTimeFormat = function MockDateTimeFormat(_locale, options = {}) {
    if (options?.timeZone) {
      return new OriginalDateTimeFormat("en-US", options);
    }

    return {
      resolvedOptions: () => ({ timeZone }),
    };
  };

  try {
    return fn();
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  }
}

test("schedule timezone helper detects browser IANA timezone", () => {
  assert.equal(
    withMockBrowserTimezone("Asia/Kolkata", getBrowserScheduleTimezone),
    "Asia/Kolkata",
  );
  assert.equal(
    withMockBrowserTimezone("America/New_York", getBrowserScheduleTimezone),
    "America/New_York",
  );
  assert.equal(
    withMockBrowserTimezone("America/Los_Angeles", getBrowserScheduleTimezone),
    "America/Los_Angeles",
  );
});

test("schedule timezone helper normalizes India alias and rejects invalid values", () => {
  assert.equal(normalizeScheduleTimezone("Asia/Calcutta"), "Asia/Kolkata");
  assert.equal(normalizeScheduleTimezone("Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(normalizeScheduleTimezone("Invalid/FakeZone"), null);
  assert.equal(normalizeScheduleTimezone(""), null);
});

test("schedule timezone flow does not use server timezone or shop timezone as browser timezone", () => {
  const scheduleHook = read("web/frontend/hooks/useScheduleTimezone.js");
  const scheduleUtil = read("web/frontend/utils/scheduleTimezone.js");
  const shopHook = read("web/frontend/hooks/useShopTimezone.js");
  const modal = read(
    "web/frontend/Domain/products/exports/components/ScheduledExportModal.jsx",
  );
  const scheduleEdit = read("web/frontend/Domain/products/edit/components/ScheduleEdit.jsx");
  const locale = read("web/frontend/locales/en/products.json");

  assert.ok(scheduleUtil.includes('typeof window === "undefined"'));
  assert.ok(scheduleUtil.includes("resolvedOptions().timeZone"));
  assert.ok(scheduleUtil.includes('"Asia/Calcutta": "Asia/Kolkata"'));
  assert.ok(scheduleHook.includes("browserTimezone") && scheduleHook.includes("shopTimezone"));
  assert.ok(scheduleHook.includes('FALLBACK_SCHEDULE_TIMEZONE = "UTC"'));
  assert.equal(shopHook.includes("getBrowserTimezone"), false);

  assert.ok(modal.includes("useScheduleTimezone"));
  assert.ok(modal.includes("timezone: resolvedTimezone"));
  assert.ok(scheduleEdit.includes("useScheduleTimezone"));
  assert.ok(
    locale.includes("All schedule times are interpreted in your local timezone: {{timezone}}."),
  );
});
