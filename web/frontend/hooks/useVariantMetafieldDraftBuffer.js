import { useCallback, useEffect, useRef } from "react";
import { useAuthenticatedFetch } from "./useAuthenticatedFetch";

const DEFAULT_DEBOUNCE_MS = 400;

function buildCellKey(variantId, namespace, key) {
  return `${variantId}:${namespace}:${key}`;
}

/**
 * Draft buffer for variant metafield cell editing.
 * - local UI is updated immediately via onDisplayValue
 * - dirty cells are merged by key (last write wins)
 * - flush is debounced and batched
 * - map is cleared before await to avoid losing edits typed during in-flight flush
 *
 * @param {string} sessionId
 * @param {{ onDisplayValue?: (variantId:string, namespace:string, key:string, value:string|null)=>void, debounceMs?: number }} [options]
 * @returns {{
 *   onCellChange: (variantId:string|number, namespace:string, key:string, value:string|null)=>void,
 *   flushNow: ()=>Promise<void>,
 *   getDirtyCount: ()=>number
 * }}
 */
export default function useVariantMetafieldDraftBuffer(sessionId, options = {}) {
  const authenticatedFetch = useAuthenticatedFetch();
  const dirtyMapRef = useRef({});
  const timerRef = useRef(null);
  const flushingRef = useRef(false);
  const shouldFlushAgainRef = useRef(false);

  const resolvedSessionId = String(sessionId || "").trim();
  const debounceMs = Number(options?.debounceMs || DEFAULT_DEBOUNCE_MS);
  const onDisplayValue =
    typeof options?.onDisplayValue === "function" ? options.onDisplayValue : null;

  const requeueFailedCells = useCallback((cells) => {
    const current = dirtyMapRef.current || {};
    for (const cell of Array.isArray(cells) ? cells : []) {
      const mapKey = buildCellKey(cell.variantId, cell.namespace, cell.key);
      // Keep newer edits if present; only restore missing keys from failed snapshot.
      if (!Object.prototype.hasOwnProperty.call(current, mapKey)) {
        current[mapKey] = cell;
      }
    }
    dirtyMapRef.current = current;
  }, []);

  const postCells = useCallback(
    async (cells) => {
      const response = await authenticatedFetch(`/api/sessions/${resolvedSessionId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cells }),
      });

      if (!response.ok) {
        let message = `Draft flush failed with status ${response.status}`;
        try {
          const body = await response.json();
          if (body?.error) message = String(body.error);
        } catch {
          // keep default message
        }
        const error = new Error(message);
        error.code = "DRAFT_FLUSH_FAILED";
        error.status = response.status;
        throw error;
      }
    },
    [authenticatedFetch, resolvedSessionId],
  );

  const flushNow = useCallback(async () => {
    if (!resolvedSessionId) return;
    if (flushingRef.current) {
      shouldFlushAgainRef.current = true;
      return;
    }

    const snapshot = Object.values(dirtyMapRef.current || {});
    if (!snapshot.length) return;

    flushingRef.current = true;
    dirtyMapRef.current = {}; // clear before await; new edits go into a fresh map.

    try {
      await postCells(snapshot);
    } catch (error) {
      requeueFailedCells(snapshot);
      throw error;
    } finally {
      flushingRef.current = false;
      if (shouldFlushAgainRef.current) {
        shouldFlushAgainRef.current = false;
        if (Object.keys(dirtyMapRef.current || {}).length > 0) {
          // Fire-and-forget follow-up flush.
          void flushNow();
        }
      }
    }
  }, [postCells, requeueFailedCells, resolvedSessionId]);

  const scheduleFlush = useCallback(() => {
    if (!resolvedSessionId) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flushNow();
    }, Math.max(100, debounceMs));
  }, [debounceMs, flushNow, resolvedSessionId]);

  const onCellChange = useCallback(
    (variantId, namespace, key, value) => {
      const variantIdText = String(variantId || "").trim();
      const namespaceText = String(namespace || "").trim();
      const keyText = String(key || "").trim();
      if (!variantIdText || !namespaceText || !keyText) return;

      if (onDisplayValue) {
        onDisplayValue(variantIdText, namespaceText, keyText, value);
      }

      const mapKey = buildCellKey(variantIdText, namespaceText, keyText);
      dirtyMapRef.current[mapKey] = {
        variantId: variantIdText,
        namespace: namespaceText,
        key: keyText,
        value: value == null ? null : String(value),
      };

      scheduleFlush();
    },
    [onDisplayValue, scheduleFlush],
  );

  const getDirtyCount = useCallback(
    () => Object.keys(dirtyMapRef.current || {}).length,
    [],
  );

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  return {
    onCellChange,
    flushNow,
    getDirtyCount,
  };
}

