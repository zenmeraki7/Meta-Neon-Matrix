import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAuthenticatedFetch } from "../../hooks/useAuthenticatedFetch";
import { useVariantMetafieldDraftBuffer } from "../../hooks/useVariantMetafieldDraftBuffer";
import { useToast as useAppToast } from "../../components/providers/ToastProvider";
import { Button, Modal, Text } from "@shopify/polaris";

const MetafieldCell = memo(function MetafieldCell({
  displayValue,
  editStatus,
  onChange,
  style,
  disabled = false,
}) {
  const [localValue, setLocalValue] = useState(displayValue ?? "");

  useEffect(() => {
    setLocalValue(displayValue ?? "");
  }, [displayValue]);

  return (
    <div
      style={{
        ...style,
        border: "1px solid #e3e3e3",
        padding: "6px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        background: "#fff",
      }}
    >
      <input
        value={localValue}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setLocalValue(next);
          onChange(next);
        }}
        style={{ width: "100%" }}
      />
      <small style={{ color: "#6d7175" }}>
        {editStatus === "WRITING" ? "WRITING..." : (editStatus || "SYNCED")}
      </small>
    </div>
  );
});

function formatSyncedAt(value) {
  if (!value) return "Never synced";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown sync time";
  return `Synced ${d.toLocaleString()}`;
}

function ColumnApplyBar({ definitions, selectedVariantIds, onApply }) {
  const [selectedDef, setSelectedDef] = useState("");
  const [value, setValue] = useState("");

  return (
    <div style={{ display: "flex", gap: "8px", marginBottom: "12px", alignItems: "center" }}>
      <select value={selectedDef} onChange={(event) => setSelectedDef(event.target.value)}>
        <option value="">Select column</option>
        {definitions.map((def) => {
          const composite = `${def.namespace}.${def.key}`;
          return (
            <option key={composite} value={composite}>
              {composite}
            </option>
          );
        })}
      </select>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onPaste={(event) => {
          if (!selectedDef || selectedVariantIds.length === 0) return;
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          const values = text.split("\n").map((v) => v.trim()).filter(Boolean);
          const [namespace, key] = selectedDef.split(".");
          onApply(namespace, key, null, values);
        }}
        placeholder="Value"
      />
      <button
        type="button"
        disabled={!selectedDef || selectedVariantIds.length === 0}
        onClick={() => {
          const [namespace, key] = selectedDef.split(".");
          onApply(namespace, key, value);
        }}
      >
        Apply
      </button>
    </div>
  );
}

export function VariantMetafieldGrid({ sessionId, variants = [], definitions = [] }) {
  const parentRef = useRef(null);
  const authenticatedFetch = useAuthenticatedFetch();
  const { showError, showSuccess } = useAppToast();
  const [selectedIds, setSelectedIds] = useState([]);
  const [displayRevision, setDisplayRevision] = useState(0);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [columnErrors, setColumnErrors] = useState([]);
  const [errorColumnFilter, setErrorColumnFilter] = useState(null);

  const baseCellLookup = useMemo(() => {
    const lookup = new Map();
    for (const variant of variants) {
      const variantId = String(variant?.id ?? variant?.variantId ?? "");
      if (!variantId) continue;
      const metafields = variant?.metafields || {};
      for (const def of definitions) {
        const cellKey = `${variantId}:${def.namespace}:${def.key}`;
        const composite = `${def.namespace}.${def.key}`;
        const source = metafields[composite] || {};
        lookup.set(cellKey, {
          value: source.value ?? null,
          pendingValue: source.pendingValue ?? null,
          editStatus: source.editStatus ?? "SYNCED",
        });
      }
    }
    return lookup;
  }, [definitions, variants]);

  const { getValue, onCellChange, setCellDisplayValue } = useVariantMetafieldDraftBuffer(sessionId, {
    resolveCell: (variantId, namespace, key) =>
      baseCellLookup.get(`${variantId}:${namespace}:${key}`) || null,
  });

  const filteredVariants = useMemo(() => {
    if (!errorColumnFilter?.variantIds?.size) return variants;
    return variants.filter((variant) => {
      const id = String(variant?.id ?? variant?.variantId ?? "");
      return errorColumnFilter.variantIds.has(id);
    });
  }, [errorColumnFilter, variants]);

  const rowVirtualizer = useVirtualizer({
    count: filteredVariants.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 5,
  });

  const columnWidths = useMemo(
    () => definitions.map((def) => ({
      namespace: def.namespace,
      key: def.key,
      width: Math.max(String(def?.name || `${def.namespace}.${def.key}`).length * 8 + 32, 120),
    })),
    [definitions],
  );
  const columnWidthLookup = useMemo(() => {
    const map = new Map();
    for (const col of columnWidths) {
      map.set(`${col.namespace}.${col.key}`, col.width);
    }
    return map;
  }, [columnWidths]);

  const toggleSelection = (variantId) => {
    const id = String(variantId || "");
    setSelectedIds((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ));
  };

  const applyColumn = async (namespace, key, value, pastedValues = null) => {
    if (!selectedIds.length) return;
    if (Array.isArray(pastedValues) && pastedValues.length !== selectedIds.length) {
      showError(`Pasted ${pastedValues.length} values but ${selectedIds.length} variants selected`);
      return;
    }

    const snapshot = selectedIds.map((id) => ({
      id,
      cell: getValue(id, namespace, key),
    }));

    for (let i = 0; i < selectedIds.length; i += 1) {
      const id = selectedIds[i];
      const nextValue = Array.isArray(pastedValues) ? pastedValues[i] : value;
      setCellDisplayValue(id, namespace, key, nextValue, { editStatus: "PENDING" });
    }
    setDisplayRevision((v) => v + 1);

    try {
      const response = Array.isArray(pastedValues)
        ? await authenticatedFetch(`/api/sessions/${sessionId}/changes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cells: selectedIds.map((variantId, i) => ({
              variantId,
              namespace,
              key,
              value: pastedValues[i],
            })),
          }),
        })
        : await authenticatedFetch(`/api/sessions/${sessionId}/changes/column-apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            namespace,
            key,
            value,
            variantIds: selectedIds,
          }),
        });
      if (!response.ok) {
        throw new Error(`Column apply failed with status ${response.status}`);
      }
      showSuccess(Array.isArray(pastedValues) ? "Pasted values staged" : "Column apply staged");
    } catch (error) {
      for (const row of snapshot) {
        setCellDisplayValue(
          row.id,
          namespace,
          key,
          row.cell?.pendingValue ?? row.cell?.value ?? null,
          { editStatus: row.cell?.editStatus ?? "SYNCED" },
        );
      }
      setDisplayRevision((v) => v + 1);
      showError("Apply failed - changes reverted");
      throw error;
    }
  };

  const loadPreviewAndConfirm = async () => {
    const response = await authenticatedFetch(`/api/sessions/${sessionId}/preview`, { method: "POST" });
    if (!response.ok) throw new Error(`Preview failed (${response.status})`);
    const payload = await response.json();
    setPreviewData(payload || null);
    setPreviewModalOpen(true);
  };

  const commitSession = async () => {
    const response = await authenticatedFetch(`/api/sessions/${sessionId}/commit`, { method: "POST" });
    if (!response.ok) throw new Error(`Commit failed (${response.status})`);
    setPreviewModalOpen(false);
    showSuccess("Commit started");
  };

  const discardAll = async () => {
    const response = await authenticatedFetch(`/api/sessions/${sessionId}/discard`, { method: "POST" });
    if (!response.ok) throw new Error(`Discard failed (${response.status})`);
    showSuccess("Discarded pending changes");
  };

  const loadColumnErrors = async () => {
    const response = await authenticatedFetch(`/api/sessions/${sessionId}/errors/columns`, { method: "GET" });
    if (!response.ok) throw new Error(`Load errors failed (${response.status})`);
    const payload = await response.json();
    setColumnErrors(Array.isArray(payload?.columns) ? payload.columns : []);
  };

  const applyErrorColumnFilter = async (namespace, key) => {
    const params = new URLSearchParams();
    params.set("namespace", namespace);
    params.set("key", key);
    const response = await authenticatedFetch(
      `/api/sessions/${sessionId}/errors/column-variants?${params.toString()}`,
      { method: "GET" },
    );
    if (!response.ok) throw new Error(`Filter load failed (${response.status})`);
    const payload = await response.json();
    const ids = new Set((payload?.variantIds || []).map((id) => String(id)));
    setErrorColumnFilter({ namespace, key, variantIds: ids });
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
        <Button onClick={() => void loadPreviewAndConfirm()}>Preview & Commit</Button>
        <Button onClick={() => void discardAll()} variant="plain">Discard all changes</Button>
        <Button onClick={() => void loadColumnErrors()} variant="plain">Show column errors</Button>
      </div>
      {columnErrors.length > 0 ? (
        <div style={{ marginBottom: "8px", fontSize: "12px", color: "#6d7175" }}>
          {errorColumnFilter ? (
            <div style={{ marginBottom: "8px" }}>
              Filtering: {errorColumnFilter.namespace}.{errorColumnFilter.key}{" "}
              <Button size="micro" variant="plain" onClick={() => setErrorColumnFilter(null)}>
                Clear
              </Button>
            </div>
          ) : null}
          {columnErrors.map((col) => (
            <div key={`${col.namespace}.${col.key}`}>
              <button
                type="button"
                style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", color: "#005bd3" }}
                onClick={() => void applyErrorColumnFilter(col.namespace, col.key)}
              >
                {col.namespace}.{col.key} - {col.errorCount} errors
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <ColumnApplyBar
        definitions={definitions}
        selectedVariantIds={selectedIds}
        onApply={applyColumn}
      />

      <div ref={parentRef} style={{ height: "80vh", overflow: "auto" }} data-revision={displayRevision}>
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            const variant = filteredVariants[vRow.index] || {};
            const variantId = String(variant?.id ?? variant?.variantId ?? `row-${vRow.index}`);
            return (
              <div
                key={variantId}
                style={{
                  position: "absolute",
                  top: 0,
                  transform: `translateY(${vRow.start}px)`,
                  display: "flex",
                  gap: "8px",
                  alignItems: "center",
                  width: "100%",
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(variantId)}
                  onChange={() => toggleSelection(variantId)}
                />
                <div style={{ minWidth: "180px", fontSize: "12px", color: "#6d7175" }}>
                  <div>{String(variant?.freshness || "FRESH")}</div>
                  <div>{formatSyncedAt(variant?.syncedAt)}</div>
                </div>
                {definitions.map((def) => {
                  const width = columnWidthLookup.get(`${def.namespace}.${def.key}`) || 120;
                  const cell = getValue(variantId, def.namespace, def.key);
                  return (
                    <MetafieldCell
                      key={`${variantId}:${def.namespace}.${def.key}`}
                      displayValue={cell.pendingValue ?? cell.value}
                      editStatus={cell.editStatus}
                      style={{
                        width: `${width}px`,
                        minWidth: `${width}px`,
                        flexShrink: 0,
                        opacity: cell.editStatus === "WRITING" ? 0.5 : 1,
                        cursor: cell.editStatus === "WRITING" ? "not-allowed" : "text",
                      }}
                      disabled={cell.editStatus === "WRITING"}
                      onChange={(value) => onCellChange(variantId, def.namespace, def.key, value)}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <Modal
        open={previewModalOpen}
        onClose={() => setPreviewModalOpen(false)}
        title={`Write ${Number(previewData?.totalCells || 0)} changes to Shopify?`}
        primaryAction={{ content: "Confirm commit", onAction: () => void commitSession() }}
        secondaryActions={[{ content: "Cancel", onAction: () => setPreviewModalOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            Affects {Number(previewData?.affectedProducts || 0)} products. ~
            {Number(previewData?.estimatedSeconds || 0)}s
          </Text>
        </Modal.Section>
      </Modal>
    </div>
  );
}

export default VariantMetafieldGrid;
