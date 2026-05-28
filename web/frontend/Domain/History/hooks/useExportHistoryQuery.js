import { useQuery } from "@tanstack/react-query";
import { historyService } from "../services/historyService";

function hasActiveExport(items = []) {
  return items.some((item) => item?.primaryStatus?.isTerminal !== true);
}

export function useExportHistoryQuery({ selectedType, cursor }) {
  return useQuery({
    queryKey: [
      "export-history-list",
      String(selectedType || "Manual export"),
      cursor || null,
      20,
    ],
    queryFn: ({ signal }) =>
      historyService.getExportHistories(
        {
          type: selectedType,
          cursor: cursor || null,
          limit: 20,
        },
        signal,
      ),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
    refetchInterval: (query) => {
      const data = query.state.data || {};
      const items = data.items || data.data || [];
      return hasActiveExport(items) ? 3000 : false;
    },
    refetchIntervalInBackground: false,
  });
}
