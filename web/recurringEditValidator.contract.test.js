import test from "node:test";
import assert from "node:assert/strict";
import { recurringEditSchema } from "./validations/recurringEditValidator.js";

const validRecurringEdit = {
  title: "Daily title cleanup",
  frequency: "Daily",
  timeToRun: "09:30",
  timezone: "UTC",
  filterParams: [
    { field: "title", operator: "contains", value: "sale" },
  ],
  steps: [
    { field: "title", editType: "Set text to value", value: "Updated title" },
  ],
};

function validate(input) {
  return recurringEditSchema.validate(input);
}

test("recurring edit schema accepts a bounded valid recurring edit", () => {
  const { error, value } = validate(validRecurringEdit);

  assert.equal(error, undefined);
  assert.equal(value.title, "Daily title cleanup");
});

test("recurring edit schema rejects unbounded title, value, and steps", () => {
  assert.match(
    validate({ ...validRecurringEdit, title: "x".repeat(256) }).error?.message || "",
    /title/,
  );

  assert.match(
    validate({
      ...validRecurringEdit,
      steps: [{ field: "title", editType: "Set text to value", value: "x".repeat(50_001) }],
    }).error?.message || "",
    /steps/,
  );

  assert.match(
    validate({
      ...validRecurringEdit,
      steps: Array.from({ length: 51 }, () => validRecurringEdit.steps[0]),
    }).error?.message || "",
    /steps/,
  );
});

test("recurring edit schema rejects unsafe filter shapes", () => {
  assert.match(
    validate({ ...validRecurringEdit, filterParams: {} }).error?.message || "",
    /filterParams/,
  );

  assert.match(
    validate({
      ...validRecurringEdit,
      filterParams: [{ field: "title", operator: "contains", value: "sale", extra: true }],
    }).error?.message || "",
    /filterParams/,
  );
});

test("recurring edit schema rejects unknown fields, operations, timezone, and payload keys", () => {
  assert.match(
    validate({
      ...validRecurringEdit,
      steps: [{ field: "unknownField", editType: "Set text to value", value: "x" }],
    }).error?.message || "",
    /steps/,
  );

  assert.match(
    validate({
      ...validRecurringEdit,
      steps: [{ field: "title", editType: "Unknown edit", value: "x" }],
    }).error?.message || "",
    /steps/,
  );

  assert.match(
    validate({ ...validRecurringEdit, timezone: "not a timezone" }).error?.message || "",
    /timezone/,
  );

  assert.match(
    validate({ ...validRecurringEdit, extra: true }).error?.message || "",
    /extra/,
  );
});

test("monthly recurring edits are capped to days that exist in every month", () => {
  const monthly = {
    ...validRecurringEdit,
    frequency: "Monthly",
    timeToRun: "09:30",
    dayOfMonthToRun: 31,
  };

  assert.match(validate(monthly).error?.message || "", /dayOfMonthToRun/);
});
