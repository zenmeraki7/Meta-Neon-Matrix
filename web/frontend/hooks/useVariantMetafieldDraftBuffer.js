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
 *   setCellDisplayValue: (variantId:string|number, namespace:string, key:string, value:string|null, options?:{editStatus?:string})=>void,
 *   flushNow: ()=>Promise<void>,
 *   getDirtyCount: ()=>number
 * }}
 */
export function useVariantMetafieldDraftBuffer(sessionId, options = {}) {
  const authenticatedFetch = useAuthenticatedFetch();
  const dirtyMapRef = useRef(new Map());
  const failedCellsRef = useRef(new Map());
  const displayMapRef = useRef(new Map());
  const timerRef = useRef(null);
  const retryTimerRef = useRef(null);
  const flushingRef = useRef(false);
  const shouldFlushAgainRef = useRef(false);

  const resolvedSessionId = String(sessionId || "").trim();
  const debounceMs = Number(options?.debounceMs || DEFAULT_DEBOUNCE_MS);
  const onDisplayValue =
    typeof options?.onDisplayValue === "function" ? options.onDisplayValue : null;
  const resolveCell =
    typeof options?.resolveCell === "function" ? options.resolveCell : null;

  const requeueFailedCells = useCallback((cells) => {
    const current = failedCellsRef.current;
    for (const cell of Array.isArray(cells) ? cells : []) {
      const mapKey = buildCellKey(cell.variantId, cell.namespace, cell.key);
      current.set(mapKey, cell);
    }
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

    const merged = new Map([...failedCellsRef.current, ...dirtyMapRef.current]);
    const snapshot = [...merged.values()];
    if (!snapshot.length) return;

    flushingRef.current = true;
    dirtyMapRef.current.clear(); // clear before await; new edits go into a fresh map.
    failedCellsRef.current.clear();

    try {
      await postCells(snapshot);
    } catch (error) {
      requeueFailedCells(snapshot);
      if (!retryTimerRef.current) {
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          void flushNow();
        }, 5000);
      }
      throw error;
    } finally {
      flushingRef.current = false;
      if (shouldFlushAgainRef.current) {
        shouldFlushAgainRef.current = false;
        if (dirtyMapRef.current.size > 0 || failedCellsRef.current.size > 0) {
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
      const base = resolveCell ? resolveCell(variantIdText, namespaceText, keyText) : null;
      displayMapRef.current.set(mapKey, {
        value: base?.value ?? null,
        pendingValue: value == null ? null : String(value),
        editStatus: "PENDING",
      });
      dirtyMapRef.current.set(mapKey, {
        variantId: variantIdText,
        namespace: namespaceText,
        key: keyText,
        value: value == null ? null : String(value),
      });

      scheduleFlush();
    },
    [onDisplayValue, resolveCell, scheduleFlush],
  );

  const setCellDisplayValue = useCallback(
    (variantId, namespace, key, value, setOptions = {}) => {
      const variantIdText = String(variantId || "").trim();
      const namespaceText = String(namespace || "").trim();
      const keyText = String(key || "").trim();
      if (!variantIdText || !namespaceText || !keyText) return;

      const mapKey = buildCellKey(variantIdText, namespaceText, keyText);
      const base = resolveCell ? resolveCell(variantIdText, namespaceText, keyText) : null;
      displayMapRef.current.set(mapKey, {
        value: base?.value ?? null,
        pendingValue: value == null ? null : String(value),
        editStatus: String(setOptions?.editStatus || "PENDING"),
      });
    },
    [resolveCell],
  );

  const getValue = useCallback(
    (variantId, namespace, key) => {
      const variantIdText = String(variantId || "").trim();
      const namespaceText = String(namespace || "").trim();
      const keyText = String(key || "").trim();
      const mapKey = buildCellKey(variantIdText, namespaceText, keyText);
      const local = displayMapRef.current.get(mapKey);
      if (local) return local;
      if (resolveCell) {
        const base = resolveCell(variantIdText, namespaceText, keyText) || {};
        return {
          value: base.value ?? null,
          pendingValue: base.pendingValue ?? null,
          editStatus: base.editStatus ?? "SYNCED",
        };
      }
      return {
        value: null,
        pendingValue: null,
        editStatus: "SYNCED",
      };
    },
    [resolveCell],
  );

  const getDirtyCount = useCallback(
    () => dirtyMapRef.current.size + failedCellsRef.current.size,
    [],
  );

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    },
    [],
  );

  return {
    onCellChange,
    setCellDisplayValue,
    getValue,
    flushNow,
    getDirtyCount,
  };
}

export default useVariantMetafieldDraftBuffer;
