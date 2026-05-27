import { useMemo } from 'react';
import { useStoreDetailsQuery } from '../../../hooks/useStoreDetailsQuery';

export function useStoreAccess() {
  const storeDetailsQuery = useStoreDetailsQuery();
  const storeAccess = storeDetailsQuery.data || null;
  const computedAlert = useMemo(
    () => !storeAccess?.webhookenableStatus?.bulkOperation,
    [storeAccess?.webhookenableStatus?.bulkOperation],
  );

  return useMemo(
    () => ({
      storeAccess,
      loadingStoreData: storeDetailsQuery.isLoading,
      errorStoreData: storeDetailsQuery.error?.message || null,
      showAlertStoreData: computedAlert,
      dismissAlertStoreData: () => {},
      verifyStoreAccess: storeDetailsQuery.refetch,
    }),
    [
      computedAlert,
      storeAccess,
      storeDetailsQuery.error?.message,
      storeDetailsQuery.isLoading,
      storeDetailsQuery.refetch,
    ],
  );
}

