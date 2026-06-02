export function debounce(fn, wait = 0) {
  let timeoutId = null;

  function debounced(...args) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, wait);
  }

  debounced.cancel = () => {
    if (!timeoutId) {
      return;
    }
    clearTimeout(timeoutId);
    timeoutId = null;
  };

  return debounced;
}

