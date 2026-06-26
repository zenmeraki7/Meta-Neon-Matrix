import { useMemo } from "react";
import { useStoreDetailsQuery } from "./useStoreDetailsQuery";

const FALLBACK_SHOP_TIMEZONE = "Asia/Kolkata";

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
  const shopTimezone = isValidTimezone(storedTimezone)
    ? storedTimezone
    : FALLBACK_SHOP_TIMEZONE;

  return useMemo(
    () => ({
      shopTimezone,
      isShopTimezoneLoading: storeDetailsQuery.isLoading,
    }),
    [shopTimezone, storeDetailsQuery.isLoading],
  );
}
