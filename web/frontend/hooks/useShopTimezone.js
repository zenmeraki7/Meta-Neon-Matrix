import { useMemo } from "react";
import { useStoreDetailsQuery } from "./useStoreDetailsQuery";

const FALLBACK_SHOP_TIMEZONE = "UTC";
const TIMEZONE_ALIASES = Object.freeze({
  "Asia/Calcutta": "Asia/Kolkata",
});

function isValidTimezone(timezone) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function useShopTimezone() {
  const storeDetailsQuery = useStoreDetailsQuery();
  const storedTimezone =
    typeof storeDetailsQuery.data?.shopTimezone === "string"
      ? storeDetailsQuery.data.shopTimezone.trim()
      : "";
  const shopTimezone = normalizeShopTimezone(storedTimezone);

  return useMemo(
    () => ({
      shopTimezone,
      isShopTimezoneLoading: storeDetailsQuery.isLoading,
    }),
    [shopTimezone, storeDetailsQuery.isLoading],
  );
}

export function normalizeShopTimezone(timezone) {
  const normalized = typeof timezone === "string" ? timezone.trim() : "";
  const canonical = TIMEZONE_ALIASES[normalized] || normalized;

  if (!isValidTimezone(canonical)) {
    return FALLBACK_SHOP_TIMEZONE;
  }

  return canonical;
}
