import { useCallback, useMemo, useState } from "react";
import { useStoreDetailsQuery } from "../../../hooks/useStoreDetailsQuery";

export function useStoreAccess(options = {}) {
  const storeDetailsQuery = useStoreDetailsQuery(options);
  const [alertDismissed, setAlertDismissed] = useState(false);

  const storeAccess = storeDetailsQuery.data ?? null;
  const bulkOperationEnabled =
    storeAccess?.webhookenableStatus?.bulkOperation === true;

  const dismissAlertStoreData = useCallback(() => {
    setAlertDismissed(true);
  }, []);

  const verifyStoreAccess = useCallback(
    () => storeDetailsQuery.refetch(),
    [storeDetailsQuery.refetch],
  );

  return useMemo(
    () => ({
      storeAccess,
      loadingStoreData: storeDetailsQuery.isLoading,
      errorStoreData: storeDetailsQuery.error?.message ?? null,
      showAlertStoreData:
        Boolean(storeAccess) &&
        !bulkOperationEnabled &&
        !alertDismissed,
      dismissAlertStoreData,
      verifyStoreAccess,
    }),
    [
      alertDismissed,
      bulkOperationEnabled,
      dismissAlertStoreData,
      storeAccess,
      storeDetailsQuery.error?.message,
      storeDetailsQuery.isLoading,
      verifyStoreAccess,
    ],
  );
}
