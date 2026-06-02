import { useMemo } from "react";
import { useStoreDetailsQuery } from "./useStoreDetailsQuery";

function getBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function useShopTimezone() {
  const storeDetailsQuery = useStoreDetailsQuery();
  const shopTimezone =
    typeof storeDetailsQuery.data?.shopTimezone === "string" &&
    storeDetailsQuery.data.shopTimezone.trim()
      ? storeDetailsQuery.data.shopTimezone.trim()
      : getBrowserTimezone();

  return useMemo(
    () => ({
      shopTimezone,
      isShopTimezoneLoading: storeDetailsQuery.isLoading,
    }),
    [shopTimezone, storeDetailsQuery.isLoading],
  );
}
