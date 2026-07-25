import { useEffect, useMemo, useState } from "react";
import { useShopTimezone } from "./useShopTimezone";
import {
  getBrowserScheduleTimezone,
  normalizeScheduleTimezone,
} from "../utils/scheduleTimezone";

const FALLBACK_SCHEDULE_TIMEZONE = "UTC";

export function useScheduleTimezone() {
  const { shopTimezone, isShopTimezoneLoading } = useShopTimezone();
  const [browserTimezone, setBrowserTimezone] = useState(null);

  useEffect(() => {
    setBrowserTimezone(getBrowserScheduleTimezone());
  }, []);

  const scheduleTimezone = useMemo(
    () =>
      normalizeScheduleTimezone(browserTimezone) ||
      normalizeScheduleTimezone(shopTimezone) ||
      FALLBACK_SCHEDULE_TIMEZONE,
    [browserTimezone, shopTimezone],
  );

  return useMemo(
    () => ({
      scheduleTimezone,
      browserTimezone,
      shopTimezone,
      isScheduleTimezoneLoading: isShopTimezoneLoading && !browserTimezone,
    }),
    [browserTimezone, isShopTimezoneLoading, scheduleTimezone, shopTimezone],
  );
}
