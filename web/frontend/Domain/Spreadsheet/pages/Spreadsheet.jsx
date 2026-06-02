import React, { useEffect, useState } from "react";
import {
    Page,
    Card,
    Button,
    BlockStack,
    InlineStack,
    Text,
    List,
    Box,
    Divider,
    Badge,
} from "@shopify/polaris";

import CsvUploader from "../components/CsvUploader";
import CsvPreviewTable from "../components/CsvPreviewTable";
import ConfirmImportModal from "../components/ConfirmImportModal";
import { buildInitialColumnMappings } from "../utils/csvParser";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { protectedApiRequest } from "../../../api/protectedApiClient";
import { useToast as useAppToast } from "../../../components/providers/ToastProvider";
import heroStyles from "../../shared/styles/HeroSurface.module.css";

export default function Spreadsheet() {
    const { t } = useTranslation();
    const PREVIEW_PAGE_SIZE = 25;
    const [file, setFile] = useState(null);
    const [previewRows, setPreviewRows] = useState([]);
    const [previewHeaders, setPreviewHeaders] = useState([]);
    const [previewTotalCount, setPreviewTotalCount] = useState(0);
    const [previewUploadToken, setPreviewUploadToken] = useState(null);
    const [previewPageInfo, setPreviewPageInfo] = useState({
        hasNextPage: false,
        hasPreviousPage: false,
        nextCursor: null,
        previousCursor: null,
    });
    const [columnMappings, setColumnMappings] = useState({});
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [status, setStatus] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [previewLoading, setPreviewLoading] = useState(false);
    const { showSuccess, showError } = useAppToast();
    const navigate = useNavigate();

    useEffect(() => {
        if (!status?.message) return;
        if (status.type === "error") {
            showError(status.message);
            return;
        }
        if (status.type === "success") {
            showSuccess(status.message);
        }
    }, [showError, showSuccess, status]);

    const handleDrop = (_, acceptedFiles) => {
        const selectedFile = acceptedFiles[0];
        if (!selectedFile) return;

        setFile(selectedFile);
        setStatus(null);
        setPreviewRows([]);
        setPreviewHeaders([]);
        setPreviewTotalCount(0);
        setPreviewUploadToken(null);
        setPreviewPageInfo({
            hasNextPage: false,
            hasPreviousPage: false,
            nextCursor: null,
            previousCursor: null,
        });

        void loadPreviewPage({ selectedFile, cursor: null, resetMappings: true });
    };

    const loadPreviewPage = async ({ selectedFile = file, cursor = null, resetMappings = false } = {}) => {
        if (!selectedFile) return;
        try {
            setPreviewLoading(true);
            let result;
            if (!previewUploadToken || resetMappings) {
                const formData = new FormData();
                formData.append("file", selectedFile);
                result = await protectedApiRequest(`/api/products/csv/preview?limit=${PREVIEW_PAGE_SIZE}`, {
                    method: "POST",
                    body: formData,
                });
                setPreviewUploadToken(result?.uploadToken || null);
            } else {
                const params = new URLSearchParams();
                params.set("uploadToken", previewUploadToken);
                params.set("limit", String(PREVIEW_PAGE_SIZE));
                if (cursor) params.set("cursor", cursor);
                result = await protectedApiRequest(`/api/products/csv/preview?${params.toString()}`, {
                    method: "GET",
                });
            }

            const headers = Array.isArray(result?.headers) ? result.headers : [];
            const items = Array.isArray(result?.items) ? result.items : [];
            if (!headers.length) {
                setStatus({
                    type: "error",
                    message: t("spreadsheetEmptyCsv", { defaultValue: "CSV file is empty." }),
                });
                return;
            }

            setPreviewRows(items);
            setPreviewHeaders(headers);
            setPreviewTotalCount(Number(result?.totalCount || 0));
            setPreviewPageInfo({
                hasNextPage: Boolean(result?.pageInfo?.hasNextPage),
                hasPreviousPage: Boolean(result?.pageInfo?.hasPreviousPage),
                nextCursor: result?.pageInfo?.nextCursor || null,
                previousCursor: result?.pageInfo?.previousCursor || null,
            });
            if (resetMappings) {
                setColumnMappings(buildInitialColumnMappings(headers));
            }
        } catch (err) {
            setStatus({
                type: "error",
                message: err.message || t("spreadsheetSomethingWentWrong"),
            });
        } finally {
            setPreviewLoading(false);
        }
    };

    const handleUpload = async () => {
        try {
            if (!file) {
                throw new Error(t("spreadsheetNoFileSelected"));
            }

            setUploading(true);

            const formData = new FormData();
            formData.append("file", file);
            formData.append("columnMappings", JSON.stringify(columnMappings));

            const result = await protectedApiRequest("/api/products/csv/import", {
                method: "POST",
                idempotent: true,
                body: formData,
            });

            setStatus({
                type: "success",
                message:
                    result?.message ||
                    t("spreadsheetImportQueued"),
            });

            setFile(null);
            setPreviewRows([]);
            setPreviewHeaders([]);
            setPreviewTotalCount(0);
            setPreviewUploadToken(null);
            setPreviewPageInfo({
                hasNextPage: false,
                hasPreviousPage: false,
                nextCursor: null,
                previousCursor: null,
            });
            setColumnMappings({});
            console.log(result);
            navigate("/editDetails/" + result.importId);
            return true;
        } catch (err) {
            setStatus({
                type: "error",
                message:
                    err.message ||
                    t("spreadsheetSomethingWentWrong"),
            });
            return false;
        } finally {
            setUploading(false);
        }
    };

    return (
        <Page
            title={t("spreadsheetImportTitle")}
            subtitle={t("spreadsheetImportSubtitle")}
            fullWidth
        >
            <BlockStack gap="500">
                {/* Intro / Guidance */}
                <Card roundedAbove="sm">
                    <Box
                        padding="700"
                        borderRadius="300"
                        overflowX="hidden"
                        overflowY="hidden"
                        className={heroStyles.heroSurface}
                    >
                        <BlockStack gap="400">
                            <BlockStack gap="200">
                                <InlineStack align="space-between" blockAlign="center">
                                    <Text as="h1" variant="headingLg">
                                        {t("spreadsheetImportNextTitle")}
                                    </Text>

                                    <Badge tone="info">
                                        {t("spreadsheetBadge")}
                                    </Badge>
                                </InlineStack>

                                <Box maxWidth="720px">
                                    <Text as="p" variant="bodyLg" tone="subdued">
                                        {t("spreadsheetIntroText")}
                                    </Text>
                                </Box>
                            </BlockStack>

                            <Box
                                padding="400"
                                borderRadius="300"
                                background="bg-surface"
                                borderWidth="025"
                                borderStyle="solid"
                                borderColor="border-secondary"
                            >
                                <BlockStack gap="250">
                                    <InlineStack align="space-between" blockAlign="center">
                                        <Text as="h5" variant="headingLg">
                                            {t("spreadsheetWarningTitle")}
                                        </Text>

                                        <Badge tone="attention">
                                            {t("spreadsheetReviewBadge")}
                                        </Badge>
                                    </InlineStack>

                                    <List type="bullet">
                                        <Box paddingBlockStart="300">
                                            <List.Item>
                                                {t("spreadsheetWarningFileType")}
                                            </List.Item>
                                            <List.Item>
                                                {t("spreadsheetWarningProductId")}
                                            </List.Item>
                                            <List.Item>
                                                {t("spreadsheetWarningVariantId")}
                                            </List.Item>
                                            <List.Item>
                                                {t("spreadsheetWarningEachRow")}
                                            </List.Item>
                                            <List.Item>
                                                {t("spreadsheetWarningIncorrectIds")}
                                            </List.Item>
                                        </Box>
                                    </List>
                                </BlockStack>
                            </Box>
                        </BlockStack>
                    </Box>
                </Card>

                {/* Uploading / status feedback is handled with Polaris Toast */}

                {/* Upload area */}
                <Card roundedAbove="sm">
                    <Box padding="0">
                        <BlockStack gap="0">
                            <Box padding="500">
                                <BlockStack gap="150">
                                    <Text as="h3" variant="headingLg">
                                        {t("spreadsheetUploadSectionTitle")}
                                    </Text>
                                    <Text as="p" variant="bodyMd" tone="subdued">
                                        {t("spreadsheetUploadSectionText")}
                                    </Text>
                                </BlockStack>
                            </Box>

                            <Divider />

                            <Box padding="500">
                                <CsvUploader
                                    file={file}
                                    onDrop={handleDrop}
                                    onRemove={() => {
                                        setFile(null);
                                        setPreviewRows([]);
                                        setPreviewHeaders([]);
                                        setPreviewTotalCount(0);
                                        setPreviewUploadToken(null);
                                        setPreviewPageInfo({
                                            hasNextPage: false,
                                            hasPreviousPage: false,
                                            nextCursor: null,
                                            previousCursor: null,
                                        });
                                        setColumnMappings({});
                                    }}
                                    disabled={uploading}
                                />
                            </Box>
                        </BlockStack>
                    </Box>
                </Card>

                {/* Preview area */}
                <Card roundedAbove="sm">
                    <Box padding="0">
                        <BlockStack gap="0">
                            <Box padding="500">
                                <BlockStack gap="150">
                                    <Text as="h3" variant="headingLg">
                                        {t("spreadsheetPreviewSectionTitle")}
                                    </Text>
                                    <Text as="p" variant="bodyMd" tone="subdued">
                                        {t("spreadsheetPreviewSectionText")}
                                    </Text>
                                </BlockStack>
                            </Box>

                            <Divider />

                            <Box padding="500">
                                <CsvPreviewTable
                                    rows={previewRows}
                                    headers={previewHeaders}
                                    totalCount={previewTotalCount}
                                    loading={previewLoading}
                                    columnMappings={columnMappings}
                                    hasPreviousPage={previewPageInfo.hasPreviousPage}
                                    hasNextPage={previewPageInfo.hasNextPage}
                                    onPrevious={() => loadPreviewPage({ cursor: previewPageInfo.previousCursor })}
                                    onNext={() => loadPreviewPage({ cursor: previewPageInfo.nextCursor })}
                                    onMappingChange={(csvCol, value) =>
                                        setColumnMappings((p) => ({
                                            ...p,
                                            [csvCol]: value,
                                        }))
                                    }
                                />
                            </Box>
                        </BlockStack>
                    </Box>
                </Card>

                {/* CTA */}
                <Card roundedAbove="sm">
                    <Box padding="500">
                        <InlineStack align="space-between" blockAlign="center">
                            <BlockStack gap="050">
                                <Text as="h4" variant="headingLg">
                                    {t("spreadsheetReadyTitle")}
                                </Text>
                                <Box paddingBlockStart="150">
                                    <Text as="p" variant="bodySm" tone="subdued">
                                        {t("spreadsheetReadyText")}
                                    </Text>
                                </Box>

                            </BlockStack>

                            <Button
                                variant="primary"
                                onClick={() => setConfirmOpen(true)}
                                disabled={!file || uploading}
                                loading={uploading}
                            >
                                {t("spreadsheetImportButton")}
                            </Button>
                        </InlineStack>
                    </Box>
                </Card>
            </BlockStack>

            <ConfirmImportModal
                open={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                onConfirm={async () => {
                    const success = await handleUpload();
                    if (success) {
                        setConfirmOpen(false);
                    }
                }}
                loading={uploading}
            />
        </Page>
    );
}
