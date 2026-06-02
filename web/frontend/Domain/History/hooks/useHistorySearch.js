// web/frontend/domains/history/hooks/useHistorySearch.js
import { useCallback, useEffect, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { debounce } from '../../../utils/debounce';
import { 
  setSearchQuery, 
  selectHistoryFilters 
} from '../../../store/slices/historySlice';

/**
 * Custom hook for managing history search
 * @returns {Object} Search state and handlers
 */
export const useHistorySearch = () => {
  const dispatch = useDispatch();
  
  // Redux selectors
  const { search } = useSelector(selectHistoryFilters);
  
  // Handle search input
  const handleSearchChange = useCallback((value) => {
    dispatch(setSearchQuery(value));
  }, [dispatch]);
  
  // Debounced search handler
  const debouncedSearchChange = useMemo(
    () => debounce((value) => {
      dispatch(setSearchQuery(value));
    }, 300),
    [dispatch],
  );

  useEffect(() => () => debouncedSearchChange.cancel(), [debouncedSearchChange]);
  
  return {
    searchValue: search,
    handleSearchChange,
    debouncedSearchChange
  };
};
