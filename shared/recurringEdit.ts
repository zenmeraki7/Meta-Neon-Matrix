export const RECURRING_FREQUENCIES = [
  "Hourly",
  "Every 2 Hours",
  "Daily",
  "Weekly",
  "Monthly",
] as const;

export type RecurringFrequency =
  (typeof RECURRING_FREQUENCIES)[number];

export const RECURRING_STATUSES = [
  "Active",
  "Inactive",
] as const;

export type RecurringStatus =
  (typeof RECURRING_STATUSES)[number];

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type Weekday =
  (typeof WEEKDAYS)[number];

export interface RecurringEditDto {
  id: string;
  title: string;
  frequency: RecurringFrequency;
  status: RecurringStatus;
  timeToRun: string | null;
  timezone: string;
  dayOfMonthToRun: number | null;
  daysOfWeekToRun: Weekday[];

  totalRuns: number;
  totalRunsSucceed: number;
  totalFails: number;
  totalRunsSkipped: number;
  totalItems: number;

  shop: string;
  isCurrentlyRunning: boolean;

  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateRecurringEditRequest {
  title: string;
  frequency: RecurringFrequency;
  status: RecurringStatus;
  timezone: string;
  timeToRun?: string;
  dayOfMonthToRun?: number;
  daysOfWeekToRun?: Weekday[];
}

export interface UpdateRecurringEditResponse {
  success: true;
  recurringEdit: RecurringEditDto;
}

export interface RecurringEditSummary {
  id: string;
  statusKey: "ACTIVE" | "PAUSED";
  field: string;
  nextRunAt: string | null;
}
