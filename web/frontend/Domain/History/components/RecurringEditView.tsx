import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { protectedApiPut } from "../../../api/protectedApiClient";
import { toSafeErrorMessage } from "../../../utils/frontendError";
import { useLocaleFormatters } from "../../../hooks/useLocaleFormatters";
import TableErrorBoundary from "../../../components/Error/TableErrorBoundary";
import CellErrorBoundary from "../../../components/Error/CellErrorBoundary";
import type {
  RecurringEditDto,
  UpdateRecurringEditRequest,
  UpdateRecurringEditResponse,
} from "../../../../../shared/recurringEdit";

const MODAL_ID = "recurring-edit-modal";

const FREQUENCY = {
  HOURLY: "Hourly",
  EVERY_TWO_HOURS: "Every 2 Hours",
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
} as const;

type RecurringFrequency =
  (typeof FREQUENCY)[keyof typeof FREQUENCY];

const RECURRING_STATUS = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
} as const;

type RecurringStatus =
  (typeof RECURRING_STATUS)[keyof typeof RECURRING_STATUS];

const TIMEZONE = {
  KOLKATA: "Asia/Kolkata",
  UTC: "UTC",
  NEW_YORK: "America/New_York",
  LONDON: "Europe/London",
  TOKYO: "Asia/Tokyo",
} as const;

type RecurringTimezone =
  (typeof TIMEZONE)[keyof typeof TIMEZONE];

const WEEKDAY = {
  SUNDAY: "Sunday",
  MONDAY: "Monday",
  TUESDAY: "Tuesday",
  WEDNESDAY: "Wednesday",
  THURSDAY: "Thursday",
  FRIDAY: "Friday",
  SATURDAY: "Saturday",
} as const;

type Weekday =
  (typeof WEEKDAY)[keyof typeof WEEKDAY];

type BadgeTone =
  | "success"
  | "warning"
  | "critical"
  | "info"
  | "neutral";

interface RecurringEditFormData {
  title: string;
  frequency: RecurringFrequency;
  status: RecurringStatus;
  timeToRun: string;
  timezone: RecurringTimezone;
  dayOfMonthToRun: number;
  daysOfWeekToRun: Weekday[];
}

interface RecurringEditData {
  id?: string | number | null;
  title?: string | null;
  frequency?: string | null;
  status?: string | null;
  timeToRun?: string | null;
  timezone?: string | null;
  dayOfMonthToRun?: number | string | null;
  daysOfWeekToRun?: unknown;
  totalRuns?: number | string | null;
  totalRunsSucceed?: number | string | null;
  totalFails?: number | string | null;
  totalRunsSkipped?: number | string | null;
  totalItems?: number | string | null;
  shop?: string | null;
  isCurrentlyRunning?: boolean | null;
  lastRunAt?: DateValue | null;
  lastRunStatus?: string | null;
  lastRunMessage?: string | null;
  durationMs?: number | string | null;
  createdAt?: DateValue | null;
  updatedAt?: DateValue | null;
  [key: string]: unknown;
}

type DateValue =
  | string
  | number
  | Date
  | {
    $date?: string | number | Date | null;
    [key: string]: unknown;
  };

interface RecurringEditModalProps {
  open: boolean;
  onClose: () => void;
  data?: RecurringEditDto | null;
  isLoading: boolean;
  error?: string | null;
  onUpdated?: () => void | Promise<void>;
}

type ValidationField =
  | keyof RecurringEditFormData;

type ValidationErrors =
  Partial<Record<ValidationField, string>>;

interface RecurringEditUpdateRequest {
  title: string;
  frequency: RecurringFrequency;
  status: RecurringStatus;
  timezone: RecurringTimezone;
  timeToRun?: string;
  dayOfMonthToRun?: number;
  daysOfWeekToRun?: Weekday[];
}

interface ApiErrorPayload {
  code?: string;
  details?: unknown;
  [key: string]: unknown;
}

interface ApiRequestError extends Error {
  status?: number;
  code?: string;
  payload?: ApiErrorPayload;
}

type ShopifyModalElement =
  HTMLElementTagNameMap["s-modal"];

type ShopifySelectElement =
  HTMLElementTagNameMap["s-select"];

type ShopifyInputElement =
  HTMLElementTagNameMap["s-text-field"];

type ShopifyCheckboxElement =
  HTMLElementTagNameMap["s-checkbox"];

type ValueEvent = FormEvent<ShopifySelectElement | ShopifyInputElement>;
type CheckboxEvent = FormEvent<ShopifyCheckboxElement>;

interface SelectOption<TValue extends string> {
  label: string;
  value: TValue;
}

interface StaticOption<TValue extends string> {
  value: TValue;
  labelKey: string;
  defaultValue: string;
}

const INITIAL_FORM_DATA: Readonly<RecurringEditFormData> =
  Object.freeze({
    title: "",
    frequency: FREQUENCY.DAILY,
    status: RECURRING_STATUS.ACTIVE,
    timeToRun: "12:00",
    timezone: TIMEZONE.KOLKATA,
    dayOfMonthToRun: 1,
    daysOfWeekToRun: [],
  });

const FREQUENCIES_WITH_TIME =
  new Set<RecurringFrequency>([
    FREQUENCY.DAILY,
    FREQUENCY.WEEKLY,
    FREQUENCY.MONTHLY,
  ]);

const WEEKDAY_OPTIONS = [
  {
    value: WEEKDAY.SUNDAY,
    labelKey: "days.sunday",
    defaultValue: "Sunday",
  },
  {
    value: WEEKDAY.MONDAY,
    labelKey: "days.monday",
    defaultValue: "Monday",
  },
  {
    value: WEEKDAY.TUESDAY,
    labelKey: "days.tuesday",
    defaultValue: "Tuesday",
  },
  {
    value: WEEKDAY.WEDNESDAY,
    labelKey: "days.wednesday",
    defaultValue: "Wednesday",
  },
  {
    value: WEEKDAY.THURSDAY,
    labelKey: "days.thursday",
    defaultValue: "Thursday",
  },
  {
    value: WEEKDAY.FRIDAY,
    labelKey: "days.friday",
    defaultValue: "Friday",
  },
  {
    value: WEEKDAY.SATURDAY,
    labelKey: "days.saturday",
    defaultValue: "Saturday",
  },
] as const satisfies readonly StaticOption<Weekday>[];

function createInitialFormData(): RecurringEditFormData {
  return {
    ...INITIAL_FORM_DATA,
    daysOfWeekToRun: [],
  };
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isApiRequestError(
  error: unknown,
): error is ApiRequestError {
  return error instanceof Error;
}

function isRecurringFrequency(
  value: unknown,
): value is RecurringFrequency {
  return Object.values(FREQUENCY).some(
    (frequency) => frequency === value,
  );
}

function isRecurringStatus(
  value: unknown,
): value is RecurringStatus {
  return Object.values(RECURRING_STATUS).some(
    (status) => status === value,
  );
}

function isRecurringTimezone(
  value: unknown,
): value is RecurringTimezone {
  return Object.values(TIMEZONE).some(
    (timezone) => timezone === value,
  );
}

function isWeekday(
  value: unknown,
): value is Weekday {
  return Object.values(WEEKDAY).some(
    (weekday) => weekday === value,
  );
}

function normalizeWeekdays(
  value: unknown,
): Weekday[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isWeekday);
}

function normalizeDayOfMonth(
  value: unknown,
): number {
  const day = Number(value);

  if (
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31
  ) {
    return 1;
  }

  return day;
}

function normalizeFrequency(
  value: unknown,
): RecurringFrequency {
  return isRecurringFrequency(value)
    ? value
    : FREQUENCY.DAILY;
}

function normalizeRecurringStatus(
  value: unknown,
): RecurringStatus {
  return isRecurringStatus(value)
    ? value
    : RECURRING_STATUS.ACTIVE;
}

function normalizeTimezone(
  value: unknown,
): RecurringTimezone {
  return isRecurringTimezone(value)
    ? value
    : TIMEZONE.KOLKATA;
}

function normalizeString(
  value: unknown,
  fallback = "",
): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return value;
}

function normalizeValidationErrors(
  value: unknown,
): ValidationErrors {
  if (!isRecord(value)) {
    return {};
  }

  const errors: ValidationErrors = {};

  for (const [key, message] of Object.entries(value)) {
    if (
      key in INITIAL_FORM_DATA &&
      typeof message === "string" &&
      message.trim()
    ) {
      errors[key as ValidationField] =
        message.trim();
    }
  }

  return errors;
}

function getOrdinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) {
    return "th";
  }

  switch (day % 10) {
    case 1:
      return "st";

    case 2:
      return "nd";

    case 3:
      return "rd";

    default:
      return "th";
  }
}

function generateTimeSlots(): ReadonlyArray<
  Readonly<SelectOption<string>>
> {
  const slots: SelectOption<string>[] = [];

  for (let hour = 0; hour < 24; hour += 1) {
    for (
      let minute = 0;
      minute < 60;
      minute += 15
    ) {
      const hourValue = String(hour).padStart(
        2,
        "0",
      );

      const minuteValue = String(minute).padStart(
        2,
        "0",
      );

      const value =
        `${hourValue}:${minuteValue}`;

      const displayHour =
        hour === 0
          ? 12
          : hour > 12
            ? hour - 12
            : hour;

      const period =
        hour >= 12 ? "PM" : "AM";

      slots.push({
        value,
        label:
          `${displayHour}:${minuteValue} ${period}`,
      });
    }
  }

  return slots;
}

const TIME_SLOT_OPTIONS = Object.freeze(
  generateTimeSlots(),
);

const DAY_OF_MONTH_OPTIONS = Object.freeze(
  Array.from({ length: 31 }, (_, index) => {
    const day = index + 1;

    return Object.freeze({
      label:
        `${day}${getOrdinalSuffix(day)}`,
      value: String(day),
    });
  }),
);

function toSafeCount(value: unknown): number {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return 0;
  }

  const count = Number(value);

  if (!Number.isFinite(count) || count < 0) {
    return 0;
  }

  return Math.trunc(count);
}

function calculateSuccessRate(
  totalRuns: unknown,
  successfulRuns: unknown,
): number {
  const total = toSafeCount(totalRuns);
  const successful =
    toSafeCount(successfulRuns);

  if (total === 0) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        (Math.min(successful, total) / total) *
        100,
      ),
    ),
  );
}

function getStatusTone(
  status: unknown,
): BadgeTone {
  switch (
  String(status ?? "")
    .trim()
    .toLowerCase()
  ) {
    case "active":
    case "success":
      return "success";

    case "inactive":
    case "paused":
    case "skipped":
      return "warning";

    case "failed":
    case "error":
      return "critical";

    case "completed":
    case "running":
    case "processing":
      return "info";

    default:
      return "neutral";
  }
}

function getSuccessRateTone(
  successRate: number,
): BadgeTone {
  if (successRate >= 80) {
    return "success";
  }

  if (successRate >= 50) {
    return "warning";
  }

  return "critical";
}

function formatDuration(
  durationMs: unknown,
  unavailableLabel: string,
): string {
  if (
    durationMs === null ||
    durationMs === undefined ||
    durationMs === "" ||
    typeof durationMs === "boolean"
  ) {
    return unavailableLabel;
  }

  const duration = Number(durationMs);

  if (
    !Number.isFinite(duration) ||
    duration < 0
  ) {
    return unavailableLabel;
  }

  return `${(duration / 1000).toFixed(2)}s`;
}

function formatDate(
  value: string | number | Date | null | undefined,
  formatter: Intl.DateTimeFormat,
  unavailableLabel: string,
): string {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return unavailableLabel;
  }

  const date =
    value instanceof Date
      ? value
      : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return unavailableLabel;
  }

  return formatter.format(date);
}

function buildFrequencyOptions(
  t: TFunction,
): SelectOption<RecurringFrequency>[] {
  return [
    {
      label: t("frequencyRecurring.hourly"),
      value: FREQUENCY.HOURLY,
    },
    {
      label: t(
        "frequencyRecurring.every2Hours",
      ),
      value: FREQUENCY.EVERY_TWO_HOURS,
    },
    {
      label: t("frequencyRecurring.daily"),
      value: FREQUENCY.DAILY,
    },
    {
      label: t("frequencyRecurring.weekly"),
      value: FREQUENCY.WEEKLY,
    },
    {
      label: t("frequencyRecurring.monthly"),
      value: FREQUENCY.MONTHLY,
    },
  ];
}

function buildStatusOptions(
  t: TFunction,
): SelectOption<RecurringStatus>[] {
  return [
    {
      label: t("statusRecurring.active"),
      value: RECURRING_STATUS.ACTIVE,
    },
    {
      label: t("statusRecurring.inactive"),
      value: RECURRING_STATUS.INACTIVE,
    },
  ];
}

function buildTimezoneOptions(
  t: TFunction,
): SelectOption<RecurringTimezone>[] {
  return [
    {
      label: t("timezoneRecurring.india"),
      value: TIMEZONE.KOLKATA,
    },
    {
      label: t("timezoneRecurring.utc"),
      value: TIMEZONE.UTC,
    },
    {
      label: t("timezoneRecurring.newYork"),
      value: TIMEZONE.NEW_YORK,
    },
    {
      label: t("timezoneRecurring.london"),
      value: TIMEZONE.LONDON,
    },
    {
      label: t("timezoneRecurring.tokyo"),
      value: TIMEZONE.TOKYO,
    },
  ];
}

function RecurringEditModal({
  open,
  onClose,
  data,
  isLoading,
  error,
  onUpdated,
}: RecurringEditModalProps) {
  const { t } = useTranslation();

  const {
    dateTimeFormatter,
    numberFormatter,
  } = useLocaleFormatters();

  const modalRef =
    useRef<ShopifyModalElement | null>(null);

  const [formData, setFormData] =
    useState<RecurringEditFormData>(
      createInitialFormData,
    );

  const [isSubmitting, setIsSubmitting] =
    useState<boolean>(false);

  const submittingRef =
    useRef<boolean>(false);

  const [submitError, setSubmitError] =
    useState<string>("");

  const [
    validationErrors,
    setValidationErrors,
  ] = useState<ValidationErrors>({});

  const frequencyOptions = useMemo(
    () => buildFrequencyOptions(t),
    [t],
  );

  const statusOptions = useMemo(
    () => buildStatusOptions(t),
    [t],
  );

  const timezoneOptions = useMemo(
    () => buildTimezoneOptions(t),
    [t],
  );

  const unavailableLabel = t(
    "common:unavailable",
    {
      defaultValue: "—",
    },
  );

  const resetModalState =
    useCallback((): void => {
      setFormData(createInitialFormData());
      setSubmitError("");
      setValidationErrors({});
      setIsSubmitting(false);
      submittingRef.current = false;
    }, []);

  const handleModalHidden =
    useCallback((): void => {
      resetModalState();

      if (open) {
        onClose();
      }
    }, [onClose, open, resetModalState]);

  useEffect(() => {
    const modal = modalRef.current;

    if (!modal) {
      return;
    }

    if (open) {
      modal.showOverlay();
    } else {
      modal.hideOverlay();
    }
  }, [open]);

  useEffect(() => {
    if (!open || !data) {
      return;
    }

    setFormData({
      title: normalizeString(data.title),
      frequency: normalizeFrequency(
        data.frequency,
      ),
      status: normalizeRecurringStatus(
        data.status,
      ),
      timeToRun:
        normalizeString(
          data.timeToRun,
          "12:00",
        ) || "12:00",
      timezone: normalizeTimezone(
        data.timezone,
      ),
      dayOfMonthToRun:
        normalizeDayOfMonth(
          data.dayOfMonthToRun,
        ),
      daysOfWeekToRun:
        normalizeWeekdays(
          data.daysOfWeekToRun,
        ),
    });

    setSubmitError("");
    setValidationErrors({});
  }, [data, open]);

  const handleFieldChange = useCallback(
    <TField extends ValidationField>(
      field: TField,
      value: RecurringEditFormData[TField],
    ): void => {
      setFormData((current) => ({
        ...current,
        [field]: value,
      }));

      setValidationErrors((current) => {
        if (!current[field]) {
          return current;
        }

        const next = { ...current };
        delete next[field];

        return next;
      });
    },
    [],
  );

  const handleDayOfWeekChange =
    useCallback(
      (
        day: Weekday,
        checked: boolean,
      ): void => {
        setFormData((current) => {
          const selectedDays =
            current.daysOfWeekToRun;

          if (checked) {
            if (
              selectedDays.includes(day)
            ) {
              return current;
            }

            return {
              ...current,
              daysOfWeekToRun: [
                ...selectedDays,
                day,
              ],
            };
          }

          return {
            ...current,
            daysOfWeekToRun:
              selectedDays.filter(
                (selectedDay) =>
                  selectedDay !== day,
              ),
          };
        });

        setValidationErrors((current) => {
          if (
            !current.daysOfWeekToRun
          ) {
            return current;
          }

          const next = { ...current };
          delete next.daysOfWeekToRun;

          return next;
        });
      },
      [],
    );

  const validateForm =
    useCallback((): boolean => {
      const errors: ValidationErrors =
        {};

      if (!formData.title.trim()) {
        errors.title = t(
          "recurringValidation.titleRequired",
          {
            defaultValue:
              "Title is required",
          },
        );
      }

      if (
        FREQUENCIES_WITH_TIME.has(
          formData.frequency,
        ) &&
        !formData.timeToRun
      ) {
        errors.timeToRun = t(
          "recurringValidation.timeRequired",
          {
            defaultValue:
              "Time to run is required for this frequency",
          },
        );
      }

      if (
        formData.frequency ===
        FREQUENCY.MONTHLY &&
        (
          !Number.isInteger(
            formData.dayOfMonthToRun,
          ) ||
          formData.dayOfMonthToRun < 1 ||
          formData.dayOfMonthToRun > 31
        )
      ) {
        errors.dayOfMonthToRun = t(
          "recurringValidation.dayRequired",
          {
            defaultValue:
              "Select a valid day of the month",
          },
        );
      }

      if (
        formData.frequency ===
        FREQUENCY.WEEKLY &&
        formData.daysOfWeekToRun
          .length === 0
      ) {
        errors.daysOfWeekToRun = t(
          "recurringValidation.weekdayRequired",
          {
            defaultValue:
              "Select at least one day",
          },
        );
      }

      setValidationErrors(errors);

      return (
        Object.keys(errors).length === 0
      );
    }, [formData, t]);

  const handleSubmit =
    useCallback(async (): Promise<void> => {
      const recurringEditId =
        data?.id == null
          ? ""
          : String(data.id).trim();

      if (
        !recurringEditId ||
        submittingRef.current
      ) {
        return;
      }

      if (!validateForm()) {
        return;
      }

      submittingRef.current = true;
      setIsSubmitting(true);
      setSubmitError("");

      try {
        const requestBody:
          RecurringEditUpdateRequest = {
          title: formData.title.trim(),
          frequency:
            formData.frequency,
          status: formData.status,
          timezone: formData.timezone,
        };

        if (
          FREQUENCIES_WITH_TIME.has(
            formData.frequency,
          )
        ) {
          requestBody.timeToRun =
            formData.timeToRun;
        }

        if (
          formData.frequency ===
          FREQUENCY.MONTHLY
        ) {
          requestBody.dayOfMonthToRun =
            formData.dayOfMonthToRun;
        }

        if (
          formData.frequency ===
          FREQUENCY.WEEKLY
        ) {
          requestBody.daysOfWeekToRun = [
            ...formData.daysOfWeekToRun,
          ];
        }

        try {
          await protectedApiPut<
            UpdateRecurringEditResponse,
            RecurringEditUpdateRequest
          >(
            `/api/products/update-recurring-edit/${encodeURIComponent(
              recurringEditId,
            )}`,
            requestBody,
            {
              idempotent: true,
            },
          );
        } catch (requestError: unknown) {
          if (
            isApiRequestError(
              requestError,
            ) &&
            requestError.status === 400
          ) {
            const details =
              requestError.payload?.details;

            setValidationErrors(
              normalizeValidationErrors(
                details,
              ),
            );
          }

          throw requestError;
        }

        await onUpdated?.();

        modalRef.current?.hideOverlay();
      } catch (
      submitRequestError: unknown
      ) {
        setSubmitError(
          toSafeErrorMessage(
            t,
            submitRequestError,
            "common.errors.generic",
          ),
        );
      } finally {
        submittingRef.current = false;
        setIsSubmitting(false);
      }
    }, [
      data?.id,
      formData,
      onUpdated,
      t,
      validateForm,
    ]);

  const handleCancel =
    useCallback((): void => {
      if (submittingRef.current) {
        return;
      }

      modalRef.current?.hideOverlay();
    }, []);

  const handleTitleInput =
    useCallback(
      (event: ValueEvent): void => {
        handleFieldChange(
          "title",
          event.currentTarget.value,
        );
      },
      [handleFieldChange],
    );

  const handleFrequencyChange =
    useCallback(
      (event: ValueEvent): void => {
        const value =
          event.currentTarget.value;

        if (!isRecurringFrequency(value)) {
          return;
        }

        handleFieldChange(
          "frequency",
          value,
        );
      },
      [handleFieldChange],
    );

  const handleStatusChange =
    useCallback(
      (event: ValueEvent): void => {
        const value =
          event.currentTarget.value;

        if (!isRecurringStatus(value)) {
          return;
        }

        handleFieldChange(
          "status",
          value,
        );
      },
      [handleFieldChange],
    );

  const handleTimezoneChange =
    useCallback(
      (event: ValueEvent): void => {
        const value =
          event.currentTarget.value;

        if (!isRecurringTimezone(value)) {
          return;
        }

        handleFieldChange(
          "timezone",
          value,
        );
      },
      [handleFieldChange],
    );

  const handleTimeChange =
    useCallback(
      (event: ValueEvent): void => {
        handleFieldChange(
          "timeToRun",
          event.currentTarget.value,
        );
      },
      [handleFieldChange],
    );

  const handleDayOfMonthChange =
    useCallback(
      (event: ValueEvent): void => {
        handleFieldChange(
          "dayOfMonthToRun",
          normalizeDayOfMonth(
            event.currentTarget.value,
          ),
        );
      },
      [handleFieldChange],
    );

  const totalRuns = toSafeCount(
    data?.totalRuns,
  );

  const successfulRuns = toSafeCount(
    data?.totalRunsSucceed,
  );

  const failedRuns = toSafeCount(
    data?.totalFails,
  );

  const skippedRuns = toSafeCount(
    data?.totalRunsSkipped,
  );

  const successRate =
    calculateSuccessRate(
      totalRuns,
      successfulRuns,
    );

  const user =
    normalizeString(data?.shop)
      .split(".")
      .filter(Boolean)[0] ||
    unavailableLabel;

  const renderFrequencyFields =
    (): React.ReactNode => {
      const { frequency } = formData;

      if (
        frequency === FREQUENCY.HOURLY ||
        frequency ===
        FREQUENCY.EVERY_TWO_HOURS
      ) {
        return (
          <s-banner
            heading={t(
              "recurringAutomaticScheduleTitle",
              {
                defaultValue:
                  "Automatic schedule",
              },
            )}
            tone="info"
          >
            <s-paragraph>
              {t(
                "recurringAutomaticScheduleText",
                {
                  defaultValue:
                    "This job runs automatically at the selected interval using the configured timezone.",
                },
              )}
            </s-paragraph>
          </s-banner>
        );
      }

      if (
        !FREQUENCIES_WITH_TIME.has(
          frequency,
        )
      ) {
        return null;
      }

      return (
        <s-stack gap="base">
          <s-select
            label={t("timeToRun")}
            name="timeToRun"
            value={formData.timeToRun}
            disabled={isSubmitting}
            required
            error={
              validationErrors.timeToRun ??
              ""
            }
            details={t(
              "timeToRunHelpText",
            )}
            onChange={handleTimeChange}
          >
            {TIME_SLOT_OPTIONS.map(
              (option) => (
                <s-option
                  key={option.value}
                  value={option.value}
                >
                  {option.label}
                </s-option>
              ),
            )}
          </s-select>

          {frequency ===
            FREQUENCY.WEEKLY ? (
            <s-stack gap="small">
              <s-text type="strong">
                {t("daysOfWeek", {
                  defaultValue:
                    "Days of week",
                })}
              </s-text>

              <s-grid
                gridTemplateColumns="repeat(auto-fit, minmax(130px, 1fr))"
                gap="small"
              >
                {WEEKDAY_OPTIONS.map(
                  (option) => {
                    const handleChange = (
                      event: CheckboxEvent,
                    ): void => {
                      handleDayOfWeekChange(
                        option.value,
                        event.currentTarget
                          .checked,
                      );
                    };

                    return (
                      <s-checkbox
                        key={option.value}
                        label={t(
                          option.labelKey,
                          {
                            defaultValue:
                              option.defaultValue,
                          },
                        )}
                        checked={formData.daysOfWeekToRun.includes(
                          option.value,
                        )}
                        disabled={
                          isSubmitting
                        }
                        onChange={
                          handleChange
                        }
                      />
                    );
                  },
                )}
              </s-grid>

              {validationErrors.daysOfWeekToRun ? (
                <s-text tone="critical">
                  {
                    validationErrors.daysOfWeekToRun
                  }
                </s-text>
              ) : null}
            </s-stack>
          ) : null}

          {frequency ===
            FREQUENCY.MONTHLY ? (
            <s-select
              label={t("dayOfMonth", {
                defaultValue:
                  "Day of month",
              })}
              name="dayOfMonthToRun"
              value={String(
                formData.dayOfMonthToRun,
              )}
              disabled={isSubmitting}
              required
              error={
                validationErrors.dayOfMonthToRun ??
                ""
              }
              details={t(
                "monthlyShortMonthWarning",
                {
                  defaultValue:
                    "Schedules for days 29–31 might not run in shorter months.",
                },
              )}
              onChange={
                handleDayOfMonthChange
              }
            >
              {DAY_OF_MONTH_OPTIONS.map(
                (option) => (
                  <s-option
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </s-option>
                ),
              )}
            </s-select>
          ) : null}
        </s-stack>
      );
    };

  let modalContent: React.ReactNode;

  if (isLoading) {
    modalContent = (
      <s-grid
        gap="base"
        justifyItems="center"
        paddingBlock="large"
      >
        <s-spinner
          accessibilityLabel={t("loading")}
          size="large"
        />

        <s-text color="subdued">
          {t(
            "loadingRecurringEditDetails",
          )}
        </s-text>
      </s-grid>
    );
  } else if (error || !data) {
    modalContent = (
      <s-banner
        heading={t("error", {
          defaultValue: "Error",
        })}
        tone="critical"
      >
        <s-paragraph>
          {error ||
            t(
              "failedToLoadRecurringEditDetails",
            )}
        </s-paragraph>
      </s-banner>
    );
  } else {
    modalContent = (
      <TableErrorBoundary>
        <s-stack gap="large">
          {submitError ? (
            <s-banner
              heading={t(
                "recurringUpdateFailed",
                {
                  defaultValue:
                    "Recurring edit could not be updated",
                },
              )}
              tone="critical"
              dismissible
              onDismiss={() =>
                setSubmitError("")
              }
            >
              <s-paragraph>
                {submitError}
              </s-paragraph>
            </s-banner>
          ) : null}

          <s-section
            heading={t("editRecurringEdit")}
          >
            <s-stack gap="base">
              <s-text-field
                label={t("title")}
                name="title"
                value={formData.title}
                placeholder={t(
                  "enterDescriptiveTitle",
                )}
                disabled={isSubmitting}
                required
                error={
                  validationErrors.title ??
                  ""
                }
                onInput={handleTitleInput}
              />

              <s-grid
                gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))"
                gap="base"
              >
                <s-select
                  label={t("frequency")}
                  name="frequency"
                  value={
                    formData.frequency
                  }
                  disabled={isSubmitting}
                  details={t(
                    "frequencyHelpText",
                  )}
                  onChange={
                    handleFrequencyChange
                  }
                >
                  {frequencyOptions.map(
                    (option) => (
                      <s-option
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </s-option>
                    ),
                  )}
                </s-select>

                <s-select
                  label={t("status")}
                  name="status"
                  value={formData.status}
                  disabled={isSubmitting}
                  details={t(
                    "statusHelpText",
                  )}
                  onChange={
                    handleStatusChange
                  }
                >
                  {statusOptions.map(
                    (option) => (
                      <s-option
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </s-option>
                    ),
                  )}
                </s-select>
              </s-grid>

              <s-select
                label={t("timezone")}
                name="timezone"
                value={formData.timezone}
                disabled={isSubmitting}
                details={t(
                  "selectTimezoneForScheduling",
                )}
                onChange={
                  handleTimezoneChange
                }
              >
                {timezoneOptions.map(
                  (option) => (
                    <s-option
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </s-option>
                  ),
                )}
              </s-select>

              {renderFrequencyFields()}
            </s-stack>
          </s-section>

          <s-divider />

          <s-section
            heading={t("executionDetails")}
          >
            <s-stack gap="large">
              <s-stack
                direction="inline"
                gap="small"
                alignItems="center"
              >
                <CellErrorBoundary fallback="[render error]">
                  <s-badge
                    tone={getStatusTone(
                      data.status,
                    )}
                  >
                    {t(
                      `statusRecurring.${String(
                        data.status ?? "",
                      ).toLowerCase()}`,
                      {
                        defaultValue:
                          data.status ||
                          t("unknown", {
                            defaultValue:
                              "Unknown",
                          }),
                      },
                    )}
                  </s-badge>
                </CellErrorBoundary>

                {data.isCurrentlyRunning ? (
                  <s-badge tone="info">
                    {t(
                      "currentlyRunning",
                    )}
                  </s-badge>
                ) : null}
              </s-stack>

              <s-grid
                gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))"
                gap="base"
              >
                <s-stack gap="small-200">
                  <s-text color="subdued">
                    {t("shop")}
                  </s-text>

                  <s-text type="strong">
                    {user}
                  </s-text>
                </s-stack>

                <s-stack gap="small-200">
                  <s-text color="subdued">
                    {t("totalProducts")}
                  </s-text>

                  <s-text type="strong">
                    {numberFormatter.format(
                      toSafeCount(
                        data.totalItems,
                      ),
                    )}
                  </s-text>
                </s-stack>
              </s-grid>

              <s-stack gap="base">
                <s-heading>
                  {t("runStatistics")}
                </s-heading>

                <s-grid
                  gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))"
                  gap="base"
                >
                  <s-stack gap="small-200">
                    <s-text color="subdued">
                      {t("totalRuns")}
                    </s-text>

                    <s-heading>
                      {numberFormatter.format(
                        totalRuns,
                      )}
                    </s-heading>
                  </s-stack>

                  <s-stack gap="small-200">
                    <s-text color="subdued">
                      {t(
                        "successfulRuns",
                      )}
                    </s-text>

                    <s-heading>
                      {numberFormatter.format(
                        successfulRuns,
                      )}
                    </s-heading>
                  </s-stack>

                  <s-stack gap="small-200">
                    <s-text color="subdued">
                      {t("failedRuns")}
                    </s-text>

                    <s-heading>
                      {numberFormatter.format(
                        failedRuns,
                      )}
                    </s-heading>
                  </s-stack>

                  <s-stack gap="small-200">
                    <s-text color="subdued">
                      {t("skippedRuns", {
                        defaultValue:
                          "Skipped runs",
                      })}
                    </s-text>

                    <s-heading>
                      {numberFormatter.format(
                        skippedRuns,
                      )}
                    </s-heading>
                  </s-stack>

                  <s-stack gap="small-200">
                    <s-text color="subdued">
                      {t("successRate")}
                    </s-text>

                    <s-badge
                      tone={getSuccessRateTone(
                        successRate,
                      )}
                    >
                      {successRate}%
                    </s-badge>
                  </s-stack>
                </s-grid>
              </s-stack>

              <s-stack gap="base">
                <s-heading>
                  {t(
                    "lastRunInformation",
                  )}
                </s-heading>

                <s-grid
                  gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))"
                  gap="base"
                >
                  <s-stack gap="small-200">
                    <s-text color="subdued">
                      {t("lastRunAt")}
                    </s-text>

                    <s-text type="strong">
                      {formatDate(
                        data.lastRunAt,
                        dateTimeFormatter,
                        unavailableLabel,
                      )}
                    </s-text>
                  </s-stack>

                  <s-stack gap="small-200">
                    <s-text color="subdued">
                      {t("status")}
                    </s-text>

                    <CellErrorBoundary fallback="[render error]">
                      <s-badge
                        tone={getStatusTone(
                          data.lastRunStatus,
                        )}
                      >
                        {t(
                          `runStatus.${String(
                            data.lastRunStatus ??
                            "unknown",
                          )
                            .trim()
                            .toLowerCase()}`,
                          {
                            defaultValue:
                              data.lastRunStatus ||
                              t("unknown", {
                                defaultValue:
                                  "Unknown",
                              }),
                          },
                        )}
                      </s-badge>
                    </CellErrorBoundary>
                  </s-stack>

                  <s-stack gap="small-200">
                    <s-text color="subdued">
                      {t("duration")}
                    </s-text>

                    <s-text type="strong">
                      {formatDuration(
                        data.durationMs,
                        unavailableLabel,
                      )}
                    </s-text>
                  </s-stack>
                </s-grid>

                {data.lastRunMessage ? (
                  <s-stack gap="small-200">
                    <s-text color="subdued">
                      {t(
                        "lastRunMessage",
                      )}
                    </s-text>

                    <CellErrorBoundary fallback="[render error]">
                      <s-text type="strong">
                        {
                          data.lastRunMessage
                        }
                      </s-text>
                    </CellErrorBoundary>
                  </s-stack>
                ) : null}
              </s-stack>

              <s-stack gap="base">
                <s-heading>
                  {t("timestamps")}
                </s-heading>

                <s-grid
                  gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))"
                  gap="base"
                >
                  <s-stack gap="small-200">
                    <s-text color="subdued">
                      {t("created")}
                    </s-text>

                    <s-text type="strong">
                      {formatDate(
                        data.createdAt,
                        dateTimeFormatter,
                        unavailableLabel,
                      )}
                    </s-text>
                  </s-stack>

                  <s-stack gap="small-200">
                    <s-text color="subdued">
                      {t("lastUpdated")}
                    </s-text>

                    <s-text type="strong">
                      {formatDate(
                        data.updatedAt,
                        dateTimeFormatter,
                        unavailableLabel,
                      )}
                    </s-text>
                  </s-stack>
                </s-grid>
              </s-stack>
            </s-stack>
          </s-section>
        </s-stack>
      </TableErrorBoundary>
    );
  }

  return (
    <s-modal
      ref={modalRef}
      id={MODAL_ID}
      heading={
        isLoading
          ? t("loading")
          : error || !data
            ? t("error", {
              defaultValue: "Error",
            })
            : t("editRecurringEdit")
      }
      accessibilityLabel={t(
        "editRecurringEdit",
      )}
      size="large-100"
      padding="base"
      onHide={handleModalHidden}
    >
      {open ? modalContent : null}

      {open &&
        !isLoading &&
        !error &&
        data ? (
        <s-button
          slot="primary-action"
          variant="primary"
          loading={isSubmitting}
          disabled={isSubmitting}
          onClick={handleSubmit}
        >
          {t("updateRecurringEdit")}
        </s-button>
      ) : null}

      {open ? (
        <s-button
          slot="secondary-actions"
          variant="secondary"
          disabled={isSubmitting}
          onClick={handleCancel}
        >
          {t("cancel", {
            defaultValue: "Close",
          })}
        </s-button>
      ) : null}
    </s-modal>
  );
}

export default RecurringEditModal;
