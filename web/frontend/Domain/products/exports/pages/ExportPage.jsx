import React, { useEffect, useMemo, useState } from "react";
import { Badge, Banner, BlockStack, Card, InlineStack, Layout, Page, Text } from "@shopify/polaris";
import { useNavigate } from "react-router-dom";
import { useSelector } from "react-redux";
import {
  selectFilters,
  selectProductCount,
  selectSearch
} from "../../../../store/slices/productSlice";
import { allFields as fallbackFields } from "../constants";

import { useTranslation } from "react-i18next";
import { useApiClient } from "../../../../hooks/useApiClient";
import { toSafeErrorMessage } from "../../../../utils/frontendError";
import useProductSyncStatus from "../../../../hooks/useProductSyncStatus";
import MirrorFreshnessBadge from "../../../../components/MirrorFreshnessBadge";

import ExportSettingsCard from "../components/ExportSettingsCard";
import FieldSelectionCard from "../components/FieldSelectionCard";
import InfoCard from "../components/InfoCard";
import ScheduledExportModal from "../components/ScheduledExportModal";
import { buildFilterAstFromLegacyFilters } from "../../list/utils/filterAst";


export default function CsvExportPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const api = useApiClient();
  const { isSyncInProgress } = useProductSyncStatus();
  const count = useSelector(selectProductCount);
  const filters = useSelector(selectFilters);
  const search = useSelector(selectSearch);

  const [selectedFields, setSelectedFields] = useState([]);
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const [loading, setLoading] = useState(false);
  const [fieldsLoading, setFieldsLoading] = useState(true);
  const [exportFields, setExportFields] = useState(fallbackFields);
  const [banner, setBanner] = useState(null);
  const [showScheduledExportModal, setShowScheduledExportModal] = useState(false);
  const targetGranularity = "PRODUCT";

  useEffect(() => {
    let ignore = false;

    async function loadExportFields() {
      setFieldsLoading(true);
      try {
        const data = await api.get(
          `/api/products/export/fields?targetGranularity=${targetGranularity}`,
        );
        const fields = Array.isArray(data?.fields) ? data.fields : [];
        if (!ignore && fields.length) {
          setExportFields(
            fields.map((field) => ({
              label: field.label,
              value: field.key,
              group: field.group || "product",
              granularity: field.granularity,
            })),
          );
          setSelectedFields((prev) =>
            prev.filter((key) => fields.some((field) => field.key === key)),
          );
        }
      } catch (err) {
        if (!ignore) {
          setBanner({
            tone: "critical",
            message: toSafeErrorMessage(t, err, "common.errors.generic"),
          });
        }
      } finally {
        if (!ignore) setFieldsLoading(false);
      }
    }

    loadExportFields();

    return () => {
      ignore = true;
    };
  }, [api, t]);

  const productFields = useMemo(() => exportFields.filter((f) => f.group === "product"), [exportFields]);
  const variantFields = useMemo(() => exportFields.filter((f) => f.group === "variant"), [exportFields]);
  const seoFields = useMemo(() => exportFields.filter((f) => f.group === "seo"), [exportFields]);

  const validateFileName = () => {
    if (!fileName.trim()) {
      setFileError("File name is required");
      return false;
    }

    if (!/^[a-zA-Z0-9-_ ]+$/.test(fileName)) {
      setFileError(
        "Only letters, numbers, spaces, dash and underscore allowed"
      );
      return false;
    }

    setFileError("");
    return true;
  };

  const effectiveFilters = useMemo(() => {
  const baseFilters = filters.filter((f) => f.field !== "search");

  if (!search?.trim()) {
    return baseFilters;
  }

  return [
    ...baseFilters,
    {
      field: "search",
      operator: "contains",
      value: search.trim(),
    },
  ];
}, [filters, search]);
  const handleExport = async () => {
    if (loading) return;
    if (!validateFileName()) return;
    if (selectedFields.length === 0) return;

    setLoading(true);
    setBanner(null);

    const payload = {
      fields: selectedFields,
      fileName: fileName.endsWith(".csv")
        ? fileName
        : `${fileName}.csv`,
      filterParams: effectiveFilters,
      filterAst: buildFilterAstFromLegacyFilters({
        filterParams: effectiveFilters,
        targetGranularity,
        source: "MANUAL_EXPORT_DEFINITION",
      }),
      context: {
        source: "MANUAL_EXPORT_DEFINITION",
      },
      options: {
        targetGranularity,
      },
    };

    try {
      const data = await api.post("/api/products/export", payload, {
        idempotent: true,
      });
      setBanner({
        tone: "success",
        message: "Export started successfully. You will receive the CSV once ready.",
      });
      navigate("/exportDetails/" + (data.exportJobId || data.data?.exportJobId));
    } catch (err) {
      setBanner({
        tone: "critical",
        message: toSafeErrorMessage(t, err, "common.errors.generic"),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Page
      title={t("exportPageTitle",)}
      subtitle={t("exportPageSubtitle",)}

      primaryAction={{
        content: loading ? t("Exporting") : t("GenerateCSV"),
        onAction: handleExport,
        disabled:
          loading ||
          selectedFields.length === 0 ||
          !fileName.trim(),
      }}
      backAction={{
        onAction: () => navigate("/products"),
      }}
      secondaryActions={[
        {
          content: t("ScheduledExport"),
          onAction: () => setShowScheduledExportModal(true),
          disabled:
            loading ||
            selectedFields.length === 0 ||
            !fileName.trim(),
        },
      ]}
    >
      <BlockStack gap="400">
        {banner && (
          <Banner
            tone={banner.tone}
            onDismiss={() => setBanner(null)}
          >
            {banner.message}
          </Banner>
        )}

        <Card>
            <InlineStack align="space-between" blockAlign="center" wrap gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  {t("exportBuilderTitle",)}
                </Text>

              <Text as="p" tone="subdued" variant="bodyMd">
                {t("exportBuilderText",)}
              </Text>
            </BlockStack>
              <InlineStack gap="200">
                <Badge tone="info">
                {count === 0
                  ? t("Allfilteredproducts")
                  : `${count} ${t("matchingProducts")}`}
              </Badge>
                <Badge>
                  {selectedFields.length} {t("fieldsselected")}
                </Badge>
                <MirrorFreshnessBadge isSyncInProgress={isSyncInProgress} />
              </InlineStack>
            </InlineStack>
          </Card>

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <ExportSettingsCard
                fileName={fileName}
                setFileName={setFileName}
                fileError={fileError}
                validateFileName={validateFileName}
                count={count}
                loading={loading}
              />

              <FieldSelectionCard
                productFields={productFields}
                variantFields={variantFields}
                seoFields={seoFields}
                selectedFields={selectedFields}
                setSelectedFields={setSelectedFields}
                allFields={exportFields}
                loading={loading || fieldsLoading}
              />
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <InfoCard />
          </Layout.Section>
        </Layout>
      </BlockStack>

      {showScheduledExportModal && (
        <ScheduledExportModal
          show
          onHide={() => setShowScheduledExportModal(false)}
          fileName={fileName.endsWith(".csv") ? fileName : `${fileName}.csv`}
          selectedFields={selectedFields}
          filters={effectiveFilters}
          count={count}
        />
      )}
    </Page>
  );
}

