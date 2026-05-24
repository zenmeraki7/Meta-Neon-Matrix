import { useEffect, useMemo, useState } from "react";
import { protectedApiGet } from "../api/protectedApiClient";

function getBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function useShopTimezone() {
  const [shopTimezone, setShopTimezone] = useState(getBrowserTimezone);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);
    protectedApiGet("/api/store/details")
      .then((data) => {
        if (!mounted) return;
        if (typeof data?.shopTimezone === "string" && data.shopTimezone.trim()) {
          setShopTimezone(data.shopTimezone.trim());
        }
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setIsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  return useMemo(
    () => ({ shopTimezone, isShopTimezoneLoading: isLoading }),
    [isLoading, shopTimezone],
  );
}
