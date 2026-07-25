import { useEffect, useState } from "react";

const DEFAULT_DEBOUNCE_DELAY = 300;

function normalizeDelay(delay) {
  const number = Number(delay);
  return Number.isFinite(number) && number >= 0
    ? Math.floor(number)
    : DEFAULT_DEBOUNCE_DELAY;
}

function normalizeOptions(options) {
  if (options && typeof options === "object") {
    return options;
  }

  return {
    delay: options,
    enabled: true,
  };
}

export default function useDebounce(value, options = {}) {
  const {
    delay = DEFAULT_DEBOUNCE_DELAY,
    enabled = true,
  } = normalizeOptions(options);
  const [debouncedValue, setDebouncedValue] = useState(value);
  const safeDelay = normalizeDelay(delay);

  useEffect(() => {
    if (!enabled || safeDelay === 0) {
      setDebouncedValue(value);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setDebouncedValue(value);
    }, safeDelay);

    return () => {
      window.clearTimeout(timer);
    };
  }, [value, safeDelay, enabled]);

  return debouncedValue;
}
