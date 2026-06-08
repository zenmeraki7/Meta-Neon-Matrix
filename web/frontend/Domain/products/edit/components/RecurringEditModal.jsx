import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import {
  Modal,
  FormLayout,
  TextField,
  Select,
  Banner,
  Checkbox,
  BlockStack,
  InlineStack,
  Text,
} from "@shopify/polaris";

import { useTranslation } from "react-i18next";
import { buildFilterAstFromLegacyFilters } from "../../list/utils/filterAst.js";
import { useShopTimezone } from "../../../../hooks/useShopTimezone";
import {
  getDateInputInTimezone,
  zonedDateTimeToUtcIso,
} from "../../../../utils/timezoneDateTime";
import { useToast as useAppToast } from "../../../../components/providers/ToastProvider";
import {
  mapCreateRecurringEditError,
  useCreateRecurringEditMutation,
} from "../hooks/useCreateRecurringEditMutation";
import { useEmbeddedNavigate } from "../../../../hooks/useEmbeddedNavigate";

const DEFAULT_TIME = "12:00";
const DEFAULT_DAY_OF_MONTH = "1";
const ACTIVE_STATUS = "ACTIVE";
const FALLBACK_TIMEZONE = "UTC";
const FREQUENCY = Object.freeze({
  HOURLY: "HOURLY",
  EVERY_2_HOURS: "EVERY_2_HOURS",
  DAILY: "DAILY",
  WEEKLY: "WEEKLY",
  MONTHLY: "MONTHLY",
});
const DEFAULT_FREQUENCY = FREQUENCY.DAILY;
const ALLOWED_FREQUENCIES = new Set([
  FREQUENCY.HOURLY,
  FREQUENCY.EVERY_2_HOURS,
  FREQUENCY.DAILY,
  FREQUENCY.WEEKLY,
  FREQUENCY.MONTHLY,
]);
const RECURRING_SCHEDULE_TYPE = Object.freeze({
  everyXMinutes: "EVERY_X_MINUTES",
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
});
const AUTOCOMPLETE_OFF = "off";
const POLARIS_TONE = Object.freeze({
  critical: "critical",
  info: "info",
  warning: "warning",
});
const TEXT_PROPS = Object.freeze({
  paragraph: "p",
  bodyMd: "bodyMd",
  semibold: "semibold",
});

const FREQUENCY_OPTIONS = Object.freeze([
  {
    labelKey: "recurringEditFrequencyOptions.Hourly",
    label: "Hourly",
    value: FREQUENCY.HOURLY,
  },
  {
    labelKey: "recurringEditFrequencyOptions.Every 2 Hours",
    label: "Every 2 Hours",
    value: FREQUENCY.EVERY_2_HOURS,
  },
  {
    labelKey: "recurringEditFrequencyOptions.Daily",
    label: "Daily",
    value: FREQUENCY.DAILY,
  },
  {
    labelKey: "recurringEditFrequencyOptions.Weekly",
    label: "Weekly",
    value: FREQUENCY.WEEKLY,
  },
  {
    labelKey: "recurringEditFrequencyOptions.Monthly",
    label: "Monthly",
    value: FREQUENCY.MONTHLY,
  },
]);

const DAYS_OF_WEEK = Object.freeze([
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]);

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;

  const stringValue = String(value).trim();

  return stringValue || fallback;
}

function safeCount(value) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return 0;
  }

  return Math.floor(numberValue);
}

function createSubmissionKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `recurring-edit:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
}

function stableSerialize(value) {
  if (value === undefined) return "null";

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(",")}}`;
}

function stableHash(value) {
  const input = stableSerialize(value);
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function createRecurringEditIdempotencyKey(payload, submissionKey) {
  return `recurring-edit:${stableHash(payload)}:${submissionKey}`;
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function validateFrequency(frequency) {
  return ALLOWED_FREQUENCIES.has(frequency);
}

function validateDayOfMonth(value) {
  const day = Number.parseInt(value, 10);
  return Number.isInteger(day) && day >= 1 && day <= 31;
}

function isValidTimezone(timezone) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function safeZonedDateTimeToUtcIso(date, time, timezone) {
  try {
    const iso = zonedDateTimeToUtcIso(date, time, timezone);
    return iso && !Number.isNaN(new Date(iso).getTime()) ? iso : null;
  } catch {
    return null;
  }
}

function getDefaultTitle(editedField, editedBy, t) {
  const safeField = editedField
    ? t(`recurringEditFields.${editedField}`, {
        defaultValue: editedField,
      })
    : t("recurringEditDefaultField", {
        defaultValue: "Field",
      });

  const safeEditType = editedBy
    ? t(`recurringEditEditTypes.${editedBy}`, {
        defaultValue: editedBy,
      })
    : t("recurringEditDefaultEditType", {
        defaultValue: "edit",
      });

  return `${safeField} ${t("recurringEditDefaultTitleConnector", {
    defaultValue: "by",
  })} ${safeEditType}`;
}

function buildInitialFormState({ editedField, editedBy, timezone, t }) {
  return {
    title: getDefaultTitle(editedField, editedBy, t),
    frequency: DEFAULT_FREQUENCY,
    timeToRun: DEFAULT_TIME,
    dayOfMonthToRun: DEFAULT_DAY_OF_MONTH,
    daysOfWeekToRun: [],
    hasStartAt: false,
    startDate: getDateInputInTimezone(timezone),
    startTime: DEFAULT_TIME,
    hasEndAt: false,
    endDate: "",
    endTime: DEFAULT_TIME,
  };
}

function recurringEditFormReducer(state, action) {
  switch (action.type) {
    case "RESET":
      return action.payload;
    case "SET_FIELD":
      if (state[action.field] === action.value) return state;
      return {
        ...state,
        [action.field]: action.value,
      };
    case "SET_WEEKDAY":
      if (action.checked) {
        if (state.daysOfWeekToRun.includes(action.day)) return state;
        return {
          ...state,
          daysOfWeekToRun: [...state.daysOfWeekToRun, action.day],
        };
      }

      return {
        ...state,
        daysOfWeekToRun: state.daysOfWeekToRun.filter(
          (item) => item !== action.day,
        ),
      };
    case "ENSURE_START_DATE":
      if (state.startDate) return state;
      return {
        ...state,
        startDate: action.value,
      };
    default:
      return state;
  }
}

function frequencyRequiresTime(frequency) {
  return (
    frequency === FREQUENCY.DAILY ||
    frequency === FREQUENCY.WEEKLY ||
    frequency === FREQUENCY.MONTHLY
  );
}

function frequencyNeedsWeekdaySelection(frequency) {
  return frequency === FREQUENCY.WEEKLY;
}

function frequencyNeedsDayOfMonthSelection(frequency) {
  return frequency === FREQUENCY.MONTHLY;
}

function getSchedulePayloadForFrequency(frequency) {
  switch (frequency) {
    case FREQUENCY.HOURLY:
      return {
        frequency: RECURRING_SCHEDULE_TYPE.everyXMinutes,
        intervalMinutes: 60,
      };
    case FREQUENCY.EVERY_2_HOURS:
      return {
        frequency: RECURRING_SCHEDULE_TYPE.everyXMinutes,
        intervalMinutes: 120,
      };
    case FREQUENCY.DAILY:
      return { frequency: RECURRING_SCHEDULE_TYPE.daily };
    case FREQUENCY.WEEKLY:
      return { frequency: RECURRING_SCHEDULE_TYPE.weekly };
    case FREQUENCY.MONTHLY:
      return { frequency: RECURRING_SCHEDULE_TYPE.monthly };
    default:
      return { frequency };
  }
}

function buildRecurringEditPayload({
  title,
  frequency,
  resolvedTimezone,
  filters,
  editedField,
  editedBy,
  value,
  searchKey,
  replaceText,
  supportValue,
  location,
  requiresTime,
  timeToRun,
  needsWeekdaySelection,
  daysOfWeekToRun,
  needsDayOfMonthSelection,
  dayOfMonthToRun,
  hasStartAt,
  startDate,
  startTime,
  hasEndAt,
  endDate,
  endTime,
  approvedPreviewCount,
}) {
  const filterAst = buildFilterAstFromLegacyFilters({
    filterParams: filters,
    targetGranularity: "PRODUCT",
    source: "RECURRING_DEFINITION",
  });
  const targetingFingerprint = stableHash({
    filterAst,
    targetGranularity: "PRODUCT",
    source: "RECURRING_DEFINITION",
  });
  const schedulePayload = getSchedulePayloadForFrequency(frequency);

  const payload = {
    title: title.trim(),
    ...schedulePayload,
    uiFrequency: frequency,
    timezone: resolvedTimezone,
    filterParams: [],
    filterAst,
    filterVersion: filterAst.version,
    targetingFingerprint,
    filterFingerprint: targetingFingerprint,
    approvedPreviewCount,
    createdAt: new Date().toISOString(),
    editedField,
    editedBy,
    value,
    searchKey,
    replaceText,
    supportValue,
    locationId: safeString(location, null),
    status: ACTIVE_STATUS,
  };

  if (requiresTime) {
    payload.timeToRun = timeToRun;
  }

  if (needsWeekdaySelection) {
    payload.daysOfWeekToRun = daysOfWeekToRun;
  }

  if (needsDayOfMonthSelection) {
    payload.dayOfMonthToRun = Number.parseInt(dayOfMonthToRun, 10);
  }

  if (hasStartAt) {
    payload.startAt = safeZonedDateTimeToUtcIso(
      startDate,
      startTime,
      resolvedTimezone
    );
  }

  if (hasEndAt) {
    payload.endAt = safeZonedDateTimeToUtcIso(
      endDate,
      endTime,
      resolvedTimezone
    );
  }

  return payload;
}

const RecurringEditBanners = memo(function RecurringEditBanners({
  upgradeWarning,
  error,
  onDismissUpgrade,
  onDismissError,
  onNavigatePricing,
  safeProductCount,
  t,
}) {
  return (
    <>
      {upgradeWarning ? (
        <Banner
          tone={POLARIS_TONE.warning}
          title={t("recurringEditUpgradeRequired", {
            defaultValue: "Upgrade required",
          })}
          onDismiss={onDismissUpgrade}
          action={{
            content: t("recurringEditUpgradePlan", {
              defaultValue: "View plans",
            }),
            onAction: onNavigatePricing,
          }}
        >
          <p>{upgradeWarning}</p>
        </Banner>
      ) : null}

      {error ? (
        <Banner tone={POLARIS_TONE.critical} onDismiss={onDismissError}>
          <p>{error}</p>
        </Banner>
      ) : null}

      <Banner tone={POLARIS_TONE.info}>
        <p>
          {t("recurringEditCurrentMatchPrefix", {
            defaultValue: "Currently matches",
          })}{" "}
          <strong>{safeProductCount}</strong>{" "}
          {t("recurringEditCurrentMatchSuffix", {
            defaultValue:
              "products. Future runs will apply to products matching these filters at run time.",
          })}
        </p>
      </Banner>
    </>
  );
});

const RecurringEditTitleField = memo(function RecurringEditTitleField({
  title,
  onTitleChange,
  submitting,
  t,
}) {
  return (
    <TextField
      label={t("recurringEditTitleLabel", {
        defaultValue: "Title",
      })}
      value={title}
      onChange={onTitleChange}
      autoComplete={AUTOCOMPLETE_OFF}
      placeholder={t("recurringEditTitlePlaceholder", {
        defaultValue: "Recurring edit title",
      })}
      disabled={submitting}
    />
  );
});

const RecurringEditScheduleFields = memo(function RecurringEditScheduleFields({
  frequency,
  translatedFrequencyOptions,
  onFrequencyChange,
  resolvedTimezone,
  requiresTime,
  timeToRun,
  onTimeToRunChange,
  needsWeekdaySelection,
  daysOfWeekToRun,
  onWeekdayChange,
  needsDayOfMonthSelection,
  dayOfMonthOptions,
  dayOfMonthToRun,
  onDayOfMonthChange,
  submitting,
  t,
}) {
  return (
    <>
      <FormLayout.Group>
        <Select
          label={t("recurringEditFrequencyLabel", {
            defaultValue: "Frequency",
          })}
          options={translatedFrequencyOptions}
          value={frequency}
          onChange={onFrequencyChange}
          disabled={submitting}
        />
      </FormLayout.Group>

      <Banner tone={POLARIS_TONE.info}>
        <p>
          {t("recurringEditTimezoneNotice", {
            defaultValue:
              "All recurring schedule times are interpreted in shop timezone:",
          })}{" "}
          <strong>{resolvedTimezone}</strong>.
        </p>
      </Banner>

      {requiresTime ? (
        <TextField
          label={t("recurringEditTimeLabel", {
            defaultValue: "Time to run",
          })}
          type="time"
          value={timeToRun}
          onChange={onTimeToRunChange}
          helpText={t("recurringEditTimeHelpText", {
            defaultValue: "Choose the time this recurring edit should run.",
          })}
          disabled={submitting}
        />
      ) : null}

      {needsWeekdaySelection ? (
        <BlockStack gap="200">
          <Text
            as={TEXT_PROPS.paragraph}
            variant={TEXT_PROPS.bodyMd}
            fontWeight={TEXT_PROPS.semibold}
          >
            {t("recurringEditDaysOfWeekLabel", {
              defaultValue: "Days of week",
            })}
          </Text>

          <InlineStack gap="300" wrap>
            {DAYS_OF_WEEK.map((day) => (
              <Checkbox
                key={day}
                label={t(`weekdays.${day}`, {
                  defaultValue: day,
                })}
                checked={daysOfWeekToRun.includes(day)}
                onChange={(checked) => onWeekdayChange(day, checked)}
                disabled={submitting}
              />
            ))}
          </InlineStack>
        </BlockStack>
      ) : null}

      {needsDayOfMonthSelection ? (
        <Select
          label={t("recurringEditDayOfMonthLabel", {
            defaultValue: "Day of month",
          })}
          options={dayOfMonthOptions}
          value={dayOfMonthToRun}
          onChange={onDayOfMonthChange}
          helpText={t("recurringEditDayOfMonthHelpText", {
            defaultValue:
              "If the selected day does not exist in a month, the backend should skip or run on the last valid day according to your scheduling policy.",
          })}
          disabled={submitting}
        />
      ) : null}
    </>
  );
});

const RecurringEditDateWindowFields = memo(
  function RecurringEditDateWindowFields({
    hasStartAt,
    onHasStartAtChange,
    startDate,
    onStartDateChange,
    startDateMin,
    startTime,
    onStartTimeChange,
    hasEndAt,
    onHasEndAtChange,
    endDate,
    onEndDateChange,
    endDateMin,
    endTime,
    onEndTimeChange,
    submitting,
    t,
  }) {
    return (
      <>
        <Checkbox
          label={t("recurringEditStartSpecificDateLabel", {
            defaultValue: "Start on a specific date",
          })}
          checked={hasStartAt}
          onChange={onHasStartAtChange}
          disabled={submitting}
        />

        {hasStartAt ? (
          <FormLayout.Group>
            <TextField
              label={t("recurringEditStartDateLabel", {
                defaultValue: "Start date",
              })}
              type="date"
              value={startDate}
              onChange={onStartDateChange}
              min={startDateMin}
              disabled={submitting}
            />

            <TextField
              label={t("recurringEditStartTimeLabel", {
                defaultValue: "Start time",
              })}
              type="time"
              value={startTime}
              onChange={onStartTimeChange}
              disabled={submitting}
            />
          </FormLayout.Group>
        ) : null}

        <Checkbox
          label={t("recurringEditStopAfterDateLabel", {
            defaultValue: "Stop after a specific date",
          })}
          checked={hasEndAt}
          onChange={onHasEndAtChange}
          disabled={submitting}
        />

        {hasEndAt ? (
          <FormLayout.Group>
            <TextField
              label={t("recurringEditEndDateLabel", {
                defaultValue: "End date",
              })}
              type="date"
              value={endDate}
              onChange={onEndDateChange}
              min={endDateMin}
              disabled={submitting}
            />

            <TextField
              label={t("recurringEditEndTimeLabel", {
                defaultValue: "End time",
              })}
              type="time"
              value={endTime}
              onChange={onEndTimeChange}
              disabled={submitting}
            />
          </FormLayout.Group>
        ) : null}
      </>
    );
  },
);

function RecurringEditModal({
  show,
  onHide,
  count,
  editedField,
  editedBy,
  value,
  searchKey,
  replaceText,
  location,
  filters,
  supportValue,
}) {
  const { t } = useTranslation();
  const navigate = useEmbeddedNavigate();
  const { shopTimezone } = useShopTimezone();
  const { showSuccess, showError } = useAppToast();
  const createRecurringEditMutation = useCreateRecurringEditMutation();

  const resolvedTimezone = shopTimezone || FALLBACK_TIMEZONE;
  const safeProductCount = safeCount(count);
  const submitting = createRecurringEditMutation.isPending;

  const [submissionKey] = useState(createSubmissionKey);

  const initialFormState = useMemo(
    () =>
      buildInitialFormState({
        editedField,
        editedBy,
        timezone: resolvedTimezone,
        t,
      }),
    [editedBy, editedField, resolvedTimezone, t]
  );

  const [form, dispatchForm] = useReducer(
    recurringEditFormReducer,
    initialFormState,
  );
  const {
    title,
    frequency,
    timeToRun,
    dayOfMonthToRun,
    daysOfWeekToRun,
    hasStartAt,
    startDate,
    startTime,
    hasEndAt,
    endDate,
    endTime,
  } = form;

  const [error, setError] = useState("");
  const [upgradeWarning, setUpgradeWarning] = useState("");

  const dayOfMonthOptions = useMemo(
    () =>
      Array.from({ length: 31 }, (_, index) => ({
        label: String(index + 1),
        value: String(index + 1),
      })),
    []
  );

  const translatedFrequencyOptions = useMemo(
    () =>
      FREQUENCY_OPTIONS.map((option) => ({
        label: t(option.labelKey, {
          defaultValue: option.label,
        }),
        value: option.value,
      })),
    [t]
  );

  const requiresTime = frequencyRequiresTime(frequency);
  const needsWeekdaySelection = frequencyNeedsWeekdaySelection(frequency);
  const needsDayOfMonthSelection = frequencyNeedsDayOfMonthSelection(frequency);

  const startDateMin = useMemo(
    () => getDateInputInTimezone(resolvedTimezone),
    [resolvedTimezone]
  );

  const endDateMin = startDate || startDateMin;

  const setFormField = useCallback((field, nextValue) => {
    dispatchForm({
      type: "SET_FIELD",
      field,
      value: nextValue,
    });
  }, []);

  const handleTitleChange = useCallback(
    (nextValue) => setFormField("title", nextValue),
    [setFormField],
  );

  const handleFrequencyChange = useCallback(
    (nextValue) => setFormField("frequency", nextValue),
    [setFormField],
  );

  const handleTimeToRunChange = useCallback(
    (nextValue) => setFormField("timeToRun", nextValue),
    [setFormField],
  );

  const handleDayOfMonthChange = useCallback(
    (nextValue) => setFormField("dayOfMonthToRun", nextValue),
    [setFormField],
  );

  const handleHasStartAtChange = useCallback(
    (nextValue) => setFormField("hasStartAt", nextValue),
    [setFormField],
  );

  const handleStartDateChange = useCallback(
    (nextValue) => setFormField("startDate", nextValue),
    [setFormField],
  );

  const handleStartTimeChange = useCallback(
    (nextValue) => setFormField("startTime", nextValue),
    [setFormField],
  );

  const handleHasEndAtChange = useCallback(
    (nextValue) => setFormField("hasEndAt", nextValue),
    [setFormField],
  );

  const handleEndDateChange = useCallback(
    (nextValue) => setFormField("endDate", nextValue),
    [setFormField],
  );

  const handleEndTimeChange = useCallback(
    (nextValue) => setFormField("endTime", nextValue),
    [setFormField],
  );

  useEffect(() => {
    if (!show) return;

    dispatchForm({
      type: "ENSURE_START_DATE",
      value: getDateInputInTimezone(resolvedTimezone),
    });
  }, [resolvedTimezone, show]);

  const handleClose = useCallback(() => {
    if (submitting) return;

    if (typeof onHide === "function") {
      onHide();
    }
  }, [onHide, submitting]);

  const handleWeekdayChange = useCallback((day, checked) => {
    dispatchForm({
      type: "SET_WEEKDAY",
      day,
      checked,
    });
  }, []);

  const validate = useCallback(() => {
    const trimmedTitle = title.trim();

    if (!trimmedTitle) {
      return t("recurringEditErrors.titleRequired", {
        defaultValue: "Title is required.",
      });
    }

    if (!validateFrequency(frequency)) {
      return t("recurringEditErrors.invalidFrequency", {
        defaultValue: "Invalid frequency.",
      });
    }

    if (!isValidTimezone(resolvedTimezone)) {
      return t("recurringEditErrors.invalidTimezone", {
        defaultValue: "Recurring edit timezone is invalid.",
      });
    }

    if (requiresTime && !isValidTime(timeToRun)) {
      return t("recurringEditErrors.timeRequired", {
        defaultValue: "Enter a valid time.",
      });
    }

    if (needsDayOfMonthSelection) {
      if (!validateDayOfMonth(dayOfMonthToRun)) {
        return t("recurringEditErrors.invalidDayOfMonth", {
          defaultValue: "Select a valid day of month.",
        });
      }
    }

    if (needsWeekdaySelection && daysOfWeekToRun.length === 0) {
      return t("recurringEditErrors.weekdayRequired", {
        defaultValue: "Select at least one weekday.",
      });
    }

    if (hasStartAt && !startDate) {
      return t("recurringEditErrors.startDateRequired", {
        defaultValue: "Start date is required.",
      });
    }

    if (hasStartAt && !isValidTime(startTime)) {
      return t("recurringEditErrors.startTimeRequired", {
        defaultValue: "Enter a valid start time.",
      });
    }

    if (hasEndAt && !endDate) {
      return t("recurringEditErrors.endDateRequired", {
        defaultValue: "End date is required.",
      });
    }

    if (hasEndAt && !isValidTime(endTime)) {
      return t("recurringEditErrors.endTimeRequired", {
        defaultValue: "Enter a valid end time.",
      });
    }

    const startAt = hasStartAt
      ? safeZonedDateTimeToUtcIso(startDate, startTime, resolvedTimezone)
      : null;

    const endAt = hasEndAt
      ? safeZonedDateTimeToUtcIso(endDate, endTime, resolvedTimezone)
      : null;

    if (hasStartAt && !startAt) {
      return t("recurringEditErrors.invalidStartAt", {
        defaultValue: "Enter a valid start date and time.",
      });
    }

    if (hasEndAt && !endAt) {
      return t("recurringEditErrors.invalidEndAt", {
        defaultValue: "Enter a valid end date and time.",
      });
    }

    const now = Date.now();

    if (startAt && new Date(startAt).getTime() <= now) {
      return t("recurringEditErrors.startInPast", {
        defaultValue: "Start date must be in the future.",
      });
    }

    if (endAt && new Date(endAt).getTime() <= now) {
      return t("recurringEditErrors.endInPast", {
        defaultValue: "End date must be in the future.",
      });
    }

    if (startAt && endAt && new Date(startAt) >= new Date(endAt)) {
      return t("recurringEditErrors.endAfterStart", {
        defaultValue: "End date must be after start date.",
      });
    }

    return "";
  }, [
    dayOfMonthToRun,
    daysOfWeekToRun.length,
    endDate,
    endTime,
    frequency,
    hasEndAt,
    hasStartAt,
    needsDayOfMonthSelection,
    needsWeekdaySelection,
    requiresTime,
    resolvedTimezone,
    startDate,
    startTime,
    timeToRun,
    title,
    t,
  ]);

  const buildSubmitPayload = useCallback(() => {
    return buildRecurringEditPayload({
      title,
      frequency,
      resolvedTimezone,
      filters,
      editedField,
      editedBy,
      value,
      searchKey,
      replaceText,
      supportValue,
      location,
      requiresTime,
      timeToRun,
      needsWeekdaySelection,
      daysOfWeekToRun,
      needsDayOfMonthSelection,
      dayOfMonthToRun,
      hasStartAt,
      startDate,
      startTime,
      hasEndAt,
      endDate,
      endTime,
      approvedPreviewCount: safeProductCount,
    });
  }, [
    dayOfMonthToRun,
    daysOfWeekToRun,
    editedBy,
    editedField,
    endDate,
    endTime,
    filters,
    frequency,
    hasEndAt,
    hasStartAt,
    location,
    needsDayOfMonthSelection,
    needsWeekdaySelection,
    replaceText,
    requiresTime,
    resolvedTimezone,
    searchKey,
    safeProductCount,
    startDate,
    startTime,
    supportValue,
    timeToRun,
    title,
    value,
  ]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;

    const validationMessage = validate();

    if (validationMessage) {
      setError(validationMessage);
      setUpgradeWarning("");
      return;
    }

    setError("");
    setUpgradeWarning("");

    let payload;

    try {
      payload = buildSubmitPayload();
    } catch {
      setError(
        t("recurringEditErrors.invalidSchedule", {
          defaultValue:
            "Schedule is invalid. Check the date, time, and timezone.",
        }),
      );
      return;
    }

    try {
      await createRecurringEditMutation.mutateAsync({
        payload,
        idempotencyKey: createRecurringEditIdempotencyKey(
          payload,
          submissionKey,
        ),
      });

      showSuccess(
        t("recurringEditSuccess.created", {
          defaultValue: "Recurring edit created.",
        })
      );

      if (typeof onHide === "function") {
        onHide();
      }

      navigate("/history");
    } catch (requestError) {
      const mappedError = mapCreateRecurringEditError(t, requestError);

      if (mappedError.isUpgradeRequired) {
        setUpgradeWarning(mappedError.message);
        return;
      }

      setError(mappedError.message);
      showError(mappedError.message);
    }
  }, [
    buildSubmitPayload,
    createRecurringEditMutation,
    navigate,
    onHide,
    showError,
    showSuccess,
    submissionKey,
    submitting,
    t,
    validate,
  ]);

  const primaryAction = useMemo(
    () => ({
      content: t("recurringEditSaveButton", {
        defaultValue: "Save recurring edit",
      }),
      onAction: handleSubmit,
      loading: submitting,
      disabled: submitting,
    }),
    [handleSubmit, submitting, t]
  );

  const secondaryActions = useMemo(
    () => [
      {
        content: t("commonCancelButton", {
          defaultValue: "Cancel",
        }),
        onAction: handleClose,
        disabled: submitting,
      },
    ],
    [handleClose, submitting, t]
  );

  const handleDismissUpgrade = useCallback(() => setUpgradeWarning(""), []);
  const handleDismissError = useCallback(() => setError(""), []);
  const handleNavigatePricing = useCallback(() => {
    navigate("/pricing");
  }, [navigate]);

  if (!show) return null;

  return (
    <Modal
      open={Boolean(show)}
      onClose={handleClose}
      title={t("recurringEditModalTitle", {
        defaultValue: "Create recurring edit",
      })}
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <RecurringEditBanners
            upgradeWarning={upgradeWarning}
            error={error}
            onDismissUpgrade={handleDismissUpgrade}
            onDismissError={handleDismissError}
            onNavigatePricing={handleNavigatePricing}
            safeProductCount={safeProductCount}
            t={t}
          />

          <FormLayout>
            <RecurringEditTitleField
              title={title}
              onTitleChange={handleTitleChange}
              submitting={submitting}
              t={t}
            />

            <RecurringEditScheduleFields
              frequency={frequency}
              translatedFrequencyOptions={translatedFrequencyOptions}
              onFrequencyChange={handleFrequencyChange}
              resolvedTimezone={resolvedTimezone}
              requiresTime={requiresTime}
              timeToRun={timeToRun}
              onTimeToRunChange={handleTimeToRunChange}
              needsWeekdaySelection={needsWeekdaySelection}
              daysOfWeekToRun={daysOfWeekToRun}
              onWeekdayChange={handleWeekdayChange}
              needsDayOfMonthSelection={needsDayOfMonthSelection}
              dayOfMonthOptions={dayOfMonthOptions}
              dayOfMonthToRun={dayOfMonthToRun}
              onDayOfMonthChange={handleDayOfMonthChange}
              submitting={submitting}
              t={t}
            />

            <RecurringEditDateWindowFields
              hasStartAt={hasStartAt}
              onHasStartAtChange={handleHasStartAtChange}
              startDate={startDate}
              onStartDateChange={handleStartDateChange}
              startDateMin={startDateMin}
              startTime={startTime}
              onStartTimeChange={handleStartTimeChange}
              hasEndAt={hasEndAt}
              onHasEndAtChange={handleHasEndAtChange}
              endDate={endDate}
              onEndDateChange={handleEndDateChange}
              endDateMin={endDateMin}
              endTime={endTime}
              onEndTimeChange={handleEndTimeChange}
              submitting={submitting}
              t={t}
            />
          </FormLayout>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export default memo(RecurringEditModal);
