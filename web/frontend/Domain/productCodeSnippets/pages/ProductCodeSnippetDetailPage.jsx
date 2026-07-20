import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  EmptyState,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  SkeletonBodyText,
  SkeletonDisplayText,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAuthenticatedFetch } from "../../../hooks/useAuthenticatedFetch";
import {
  archiveProductCodeSnippet,
  createProductCodeSnippet,
  getProductCodeSnippet,
  previewProductCodeSnippet,
  searchPreviewProducts,
  updateProductCodeSnippet,
  validateProductCodeSnippet,
} from "../services/productCodeSnippetService";

const EMPTY_SNIPPET = {
  title: "",
  status: "DRAFT",
  code: "",
};

function getStatusTone(status) {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "ARCHIVED":
      return "critical";
    default:
      return "attention";
  }
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

export default function ProductCodeSnippetDetailPage({ snippetId = null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fetchFn = useAuthenticatedFetch();
  const isNew = !snippetId;

  const [formState, setFormState] = useState(EMPTY_SNIPPET);
  const [savedSnippet, setSavedSnippet] = useState(null);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [pageError, setPageError] = useState("");
  const [validationMessage, setValidationMessage] = useState("");
  const [previewResult, setPreviewResult] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [debouncedProductSearch, setDebouncedProductSearch] = useState("");
  const [productOptions, setProductOptions] = useState([]);
  const [selectedProductId, setSelectedProductId] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedProductSearch(productSearch.trim());
    }, 300);

    return () => window.clearTimeout(timer);
  }, [productSearch]);

  useEffect(() => {
    if (isNew) {
      setLoading(false);
      return;
    }

    let active = true;

    const loadSnippet = async () => {
      setLoading(true);
      setPageError("");

      try {
        const snippet = await getProductCodeSnippet(fetchFn, snippetId);
        if (!active) return;
        setSavedSnippet(snippet);
        setFormState({
          title: snippet.title || "",
          status: snippet.status || "DRAFT",
          code: snippet.code || "",
        });
      } catch (err) {
        if (active) {
          setPageError(
            err.message ||
              t("snippetDetail.errors.load", {
                defaultValue: "Failed to load snippet",
              })
          );
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    loadSnippet();
    return () => {
      active = false;
    };
  }, [fetchFn, isNew, snippetId]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const loadProducts = async () => {
      try {
        const products = await searchPreviewProducts(
          fetchFn,
          debouncedProductSearch,
          { signal: controller.signal }
        );
        if (!active) return;

        setProductOptions(
          products.map((product) => ({
            label: product.handle
              ? `${product.title} (${product.handle})`
              : product.title,
            value: product.id,
            product,
          }))
        );
      } catch (_err) {
        if (_err?.name === "AbortError") {
          return;
        }
        if (active) {
          setProductOptions([]);
        }
      }
    };

    loadProducts();
    return () => {
      active = false;
      controller.abort();
    };
  }, [debouncedProductSearch, fetchFn]);

  const selectedProduct = useMemo(() => {
    const option = productOptions.find(
      (item) => item.value === selectedProductId
    );
    return option?.product || previewResult?.product || null;
  }, [previewResult, productOptions, selectedProductId]);
  const normalizedOutputJson = useMemo(
    () => formatJson(previewResult?.normalizedOutput ?? null),
    [previewResult?.normalizedOutput]
  );
  const rulePreviewJson = useMemo(
    () => formatJson(previewResult?.rulePreview ?? null),
    [previewResult?.rulePreview]
  );

  const isArchived = (savedSnippet?.status || formState.status) === "ARCHIVED";
  const isDirty = isNew
    ? Boolean(formState.title || formState.code)
    : Boolean(
        savedSnippet &&
          (savedSnippet.title !== formState.title ||
            savedSnippet.status !== formState.status ||
            savedSnippet.code !== formState.code)
      );

  const canSave =
    !isArchived &&
    !saving &&
    Boolean(formState.title.trim() && formState.code.trim());
  const canValidate = !isNew && !isDirty && !isArchived && !validating;
  const canPreview =
    !isNew &&
    !isDirty &&
    !isArchived &&
    Boolean(selectedProductId) &&
    !previewing;

  const supportedInputFields = [
    "title",
    "handle",
    "vendor",
    "productType",
    "status",
    "tags",
    "description",
    "categoryName",
    "totalInventory",
    "variants.price",
    "variants.compareAtPrice",
    "variants.sku",
    "variants.barcode",
    "variants.taxable",
    "variants.inventoryPolicy",
  ].join(", ");

  const supportedOutputFields = [
    "title",
    "handle",
    "vendor",
    "productType",
    "description",
    "metaTitle",
    "metaDescription",
    "status",
    "tags",
    "price",
    "compareAtPrice",
    "sku",
    "barcode",
    "taxable",
    "inventoryPolicy",
  ].join(", ");

  const handleFieldChange = (field) => (value) => {
    setFormState((current) => ({
      ...current,
      [field]: value,
    }));
    setPageError("");
  };

  const handleDiscardChanges = () => {
    setPageError("");
    setValidationMessage("");
    if (isNew) {
      setFormState(EMPTY_SNIPPET);
      return;
    }
    if (savedSnippet) {
      setFormState({
        title: savedSnippet.title || "",
        status: savedSnippet.status || "DRAFT",
        code: savedSnippet.code || "",
      });
    }
  };

  const handleSave = async () => {
    if (!canSave) return;

    setSaving(true);
    setPageError("");
    setValidationMessage("");

    try {
      const payload = {
        title: formState.title.trim(),
        status: formState.status,
        code: formState.code,
      };

      const snippet = isNew
        ? await createProductCodeSnippet(fetchFn, payload)
        : await updateProductCodeSnippet(fetchFn, snippetId, payload);

      setSavedSnippet(snippet);
      setFormState({
        title: snippet.title,
        status: snippet.status,
        code: snippet.code,
      });
      setValidationMessage(
        t("snippetDetail.messages.savedAndValidated", {
          defaultValue: "Snippet saved and validated successfully.",
        })
      );

      if (isNew) {
        navigate(`/product-code-snippets/${snippet.id}`, { replace: true });
      }
    } catch (err) {
      setPageError(
        err.message ||
          t("snippetDetail.errors.save", {
            defaultValue: "Failed to save snippet",
          })
      );
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    if (!canValidate) return;

    setValidating(true);
    setPageError("");
    setValidationMessage("");

    try {
      const result = await validateProductCodeSnippet(fetchFn, snippetId);
      setSavedSnippet(result.snippet);
      if (result.validationStatus === "VALID") {
        setValidationMessage(
          t("snippetDetail.messages.validationPassed", {
            defaultValue: "Snippet validation passed.",
          })
        );
      } else {
        setPageError(
          result.error ||
            t("snippetDetail.errors.validationFailed", {
              defaultValue: "Snippet validation failed",
            })
        );
      }
    } catch (err) {
      setPageError(
        err.message ||
          t("snippetDetail.errors.validation", {
            defaultValue: "Validation failed",
          })
      );
    } finally {
      setValidating(false);
    }
  };

  const handlePreview = async () => {
    if (!canPreview) return;

    setPreviewing(true);
    setPageError("");

    try {
      const result = await previewProductCodeSnippet(
        fetchFn,
        snippetId,
        selectedProductId
      );
      setPreviewResult(result);
    } catch (err) {
      setPageError(
        err.message ||
          t("snippetDetail.errors.preview", {
            defaultValue: "Preview failed",
          })
      );
      setPreviewResult(null);
    } finally {
      setPreviewing(false);
    }
  };

  const handleArchive = async () => {
    if (isNew || !savedSnippet) return;

    setSaving(true);
    setPageError("");

    try {
      await archiveProductCodeSnippet(fetchFn, savedSnippet.id);
      navigate("/product-code-snippets");
    } catch (err) {
      setPageError(
        err.message ||
          t("snippetDetail.errors.archive", {
            defaultValue: "Failed to archive snippet",
          })
      );
    } finally {
      setSaving(false);
      setShowDeleteModal(false);
    }
  };

  return (
    <>
      <Page
        fullWidth
        backAction={{
          content: t("snippetDetail.actions.back", {
            defaultValue: "Back to snippets",
          }),
          onAction: () => navigate("/product-code-snippets"),
        }}
        title={
          isNew
            ? t("snippetDetail.newTitle", { defaultValue: "New snippet" })
            : savedSnippet?.title ||
              t("snippetDetail.fallbackTitle", { defaultValue: "Snippet" })
        }
        titleMetadata={
          <InlineStack gap="200">
            {!isNew && (
              <Badge tone={getStatusTone(savedSnippet?.status)}>
                {savedSnippet?.status}
              </Badge>
            )}
            {isDirty && (
              <Badge tone="attention">
                {t("snippetDetail.unsavedChanges", {
                  defaultValue: "Unsaved changes",
                })}
              </Badge>
            )}
          </InlineStack>
        }
        subtitle={t("snippetDetail.subtitle", {
          defaultValue:
            "Write safe product logic, validate it against the snippet DSL, and preview the normalized edit payload before using it anywhere else.",
        })}
        primaryAction={{
          content: saving
            ? t("snippetDetail.actions.saving", { defaultValue: "Saving" })
            : isNew
            ? t("snippetDetail.actions.saveSnippet", {
                defaultValue: "Save snippet",
              })
            : t("snippetDetail.actions.saveChanges", {
                defaultValue: "Save changes",
              }),
          onAction: handleSave,
          loading: saving,
          disabled: !canSave,
        }}
        secondaryActions={[
          {
            content: validating
              ? t("snippetDetail.actions.validating", {
                  defaultValue: "Validating",
                })
              : t("snippetDetail.actions.validate", {
                  defaultValue: "Validate",
                }),
            onAction: handleValidate,
            disabled: !canValidate,
            loading: validating,
          },
          {
            content: previewing
              ? t("snippetDetail.actions.previewing", {
                  defaultValue: "Previewing",
                })
              : t("snippetDetail.actions.runPreview", {
                  defaultValue: "Run preview",
                }),
            onAction: handlePreview,
            disabled: !canPreview,
            loading: previewing,
          },
          ...(!isNew
            ? [
                {
                  content: t("snippetDetail.actions.archive", {
                    defaultValue: "Archive",
                  }),
                  destructive: true,
                  onAction: () => setShowDeleteModal(true),
                },
              ]
            : []),
        ]}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {loading ? (
                <Card>
                  <Box padding="400">
                    <BlockStack gap="300">
                      <SkeletonDisplayText size="small" />
                      <SkeletonBodyText lines={10} />
                    </BlockStack>
                  </Box>
                </Card>
              ) : (
                <>
                  {pageError && (
                    <Banner
                      tone="critical"
                      title={t("snippetDetail.banners.issue", {
                        defaultValue: "Snippet issue",
                      })}
                    >
                      <p>{pageError}</p>
                    </Banner>
                  )}

                  {validationMessage && (
                    <Banner
                      tone="success"
                      title={t("snippetDetail.banners.ready", {
                        defaultValue: "Snippet ready",
                      })}
                    >
                      <p>{validationMessage}</p>
                    </Banner>
                  )}

                  {isDirty && (
                    <Banner
                      tone="info"
                      title={t("snippetDetail.unsavedChanges", {
                        defaultValue: "Unsaved changes",
                      })}
                      action={{
                        content: saving
                          ? t("snippetDetail.actions.saving", {
                              defaultValue: "Saving",
                            })
                          : t("snippetDetail.actions.saveChanges", {
                              defaultValue: "Save changes",
                            }),
                        onAction: handleSave,
                        disabled: !canSave || saving,
                      }}
                      secondaryAction={{
                        content: t("snippetDetail.actions.discard", {
                          defaultValue: "Discard",
                        }),
                        onAction: handleDiscardChanges,
                        disabled: saving,
                      }}
                    >
                      <p>
                        {t("snippetDetail.banners.unsavedMessage", {
                          defaultValue:
                            "Review and save or discard changes before validating and previewing.",
                        })}
                      </p>
                    </Banner>
                  )}

                  {isArchived && (
                    <Banner
                      tone="warning"
                      title={t("snippetDetail.banners.archived", {
                        defaultValue: "Archived snippet",
                      })}
                    >
                      <p>
                        {t("snippetDetail.banners.archivedMessage", {
                          defaultValue:
                            "This snippet is archived and read-only.",
                        })}
                      </p>
                    </Banner>
                  )}

                  <Card>
                    <Box padding="400">
                      <BlockStack gap="400">
                        <InlineStack align="space-between" blockAlign="center">
                          <BlockStack gap="100">
                            <Text as="h2" variant="headingMd">
                              {t("snippetDetail.sections.details", {
                                defaultValue: "Snippet details",
                              })}
                            </Text>
                            <Text variant="bodySm" tone="subdued">
                              {t("snippetDetail.sections.detailsDescription", {
                                defaultValue:
                                  "Give the snippet a clear name and keep it in draft until the preview looks right.",
                              })}
                            </Text>
                          </BlockStack>
                          <Badge tone={getStatusTone(formState.status)}>
                            {formState.status}
                          </Badge>
                        </InlineStack>

                        <TextField
                          label={t("snippetDetail.fields.title", {
                            defaultValue: "Snippet title",
                          })}
                          value={formState.title}
                          onChange={handleFieldChange("title")}
                          autoComplete="off"
                          disabled={isArchived}
                        />

                        <Select
                          label={t("snippetDetail.fields.status", {
                            defaultValue: "Snippet status",
                          })}
                          value={formState.status}
                          onChange={handleFieldChange("status")}
                          options={[
                            {
                              label: t("snippetDetail.status.draft", {
                                defaultValue: "Draft",
                              }),
                              value: "DRAFT",
                            },
                            {
                              label: t("snippetDetail.status.active", {
                                defaultValue: "Active",
                              }),
                              value: "ACTIVE",
                            },
                          ]}
                          disabled={isArchived}
                        />
                      </BlockStack>
                    </Box>
                  </Card>

                  <Card>
                    <Box padding="400">
                      <BlockStack gap="400">
                        <BlockStack gap="100">
                          <Text as="h2" variant="headingMd">
                            {t("snippetDetail.sections.logic", {
                              defaultValue: "Snippet logic",
                            })}
                          </Text>
                          <Text variant="bodySm" tone="subdued">
                            {t("snippetDetail.sections.logicDescription", {
                              defaultValue:
                                "Use the safe JSON snippet DSL with optional when, required then, and optional else objects.",
                            })}
                          </Text>
                        </BlockStack>

                        <TextField
                          label={t("snippetDetail.fields.code", {
                            defaultValue: "Snippet code",
                          })}
                          value={formState.code}
                          onChange={handleFieldChange("code")}
                          autoComplete="off"
                          multiline={18}
                          disabled={isArchived}
                        />
                      </BlockStack>
                    </Box>
                  </Card>

                  <Card>
                    <Box padding="400">
                      <BlockStack gap="300">
                        <Text as="h2" variant="headingMd">
                          {t("snippetDetail.sections.schema", {
                            defaultValue: "Supported schema",
                          })}
                        </Text>
                        <Text variant="bodySm" tone="subdued">
                          {t("snippetDetail.schema.conditionFields", {
                            defaultValue: "Condition fields: {{fields}}",
                            fields: supportedInputFields,
                          })}
                        </Text>
                        <Divider />
                        <Text variant="bodySm" tone="subdued">
                          {t("snippetDetail.schema.outputFields", {
                            defaultValue: "Output fields: {{fields}}",
                            fields: supportedOutputFields,
                          })}
                        </Text>
                        <Divider />
                        <Text variant="bodySm" tone="subdued">
                          {t("snippetDetail.schema.operators", {
                            defaultValue:
                              "Supported operators: equals, notEquals, contains, notContains, greaterThan, greaterThanOrEqual, lessThan, lessThanOrEqual, in, notIn, exists, isEmpty.",
                          })}
                        </Text>
                      </BlockStack>
                    </Box>
                  </Card>
                </>
              )}
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <Box padding="400">
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      {t("snippetDetail.sections.previewProduct", {
                        defaultValue: "Preview with a product",
                      })}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      {t("snippetDetail.sections.previewProductDescription", {
                        defaultValue:
                          "Choose a real product from your mirror data, then run a non-mutating preview of the normalized output.",
                      })}
                    </Text>

                    <TextField
                      label={t("snippetDetail.fields.findProduct", {
                        defaultValue: "Find product",
                      })}
                      value={productSearch}
                      onChange={setProductSearch}
                      placeholder={t("snippetDetail.fields.productSearch", {
                        defaultValue: "Search by title, handle, or vendor",
                      })}
                      autoComplete="off"
                    />

                    <Select
                      label={t("snippetDetail.fields.previewProduct", {
                        defaultValue: "Preview product",
                      })}
                      value={selectedProductId}
                      onChange={setSelectedProductId}
                      options={[
                        {
                          label: productOptions.length
                            ? t("snippetDetail.products.select", {
                                defaultValue: "Select a product",
                              })
                            : t("snippetDetail.products.noneFound", {
                                defaultValue: "No products found",
                              }),
                          value: "",
                        },
                        ...productOptions.map((item) => ({
                          label: item.label,
                          value: item.value,
                        })),
                      ]}
                    />

                    <Button
                      variant="primary"
                      onClick={handlePreview}
                      disabled={!canPreview}
                    >
                      {t("snippetDetail.actions.runPreview", {
                        defaultValue: "Run preview",
                      })}
                    </Button>

                    {isNew && (
                      <Text variant="bodySm" tone="subdued">
                        {t("snippetDetail.preview.saveFirst", {
                          defaultValue:
                            "Save the snippet once to enable validation and preview.",
                        })}
                      </Text>
                    )}
                    {!isNew && isDirty && (
                      <Text variant="bodySm" tone="subdued">
                        {t("snippetDetail.preview.saveLatest", {
                          defaultValue:
                            "Save your latest edits before running preview.",
                        })}
                      </Text>
                    )}
                  </BlockStack>
                </Box>
              </Card>

              <Card>
                <Box padding="400">
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingMd">
                      {t("snippetDetail.sections.selectedProduct", {
                        defaultValue: "Selected product",
                      })}
                    </Text>

                    {!selectedProduct ? (
                      <EmptyState
                        heading={t("snippetDetail.products.noneSelected", {
                          defaultValue: "No product selected",
                        })}
                        image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                      >
                        <p>
                          {t("snippetDetail.products.chooseToPreview", {
                            defaultValue:
                              "Choose a product to unlock preview testing.",
                          })}
                        </p>
                      </EmptyState>
                    ) : (
                      <BlockStack gap="100">
                        <Text variant="headingSm">{selectedProduct.title}</Text>
                        <Text variant="bodySm" tone="subdued">
                          {selectedProduct.handle
                            ? t("snippetDetail.products.handle", {
                                defaultValue: "Handle: {{handle}}",
                                handle: selectedProduct.handle,
                              })
                            : t("snippetDetail.products.noHandle", {
                                defaultValue: "No handle",
                              })}
                        </Text>
                        <Text variant="bodySm" tone="subdued">
                          {t("snippetDetail.products.status", {
                            defaultValue: "Status: {{status}}",
                            status: selectedProduct.status,
                          })}
                        </Text>
                        {selectedProduct.vendor && (
                          <Text variant="bodySm" tone="subdued">
                            {t("snippetDetail.products.vendor", {
                              defaultValue: "Vendor: {{vendor}}",
                              vendor: selectedProduct.vendor,
                            })}
                          </Text>
                        )}
                      </BlockStack>
                    )}
                  </BlockStack>
                </Box>
              </Card>

              <Card>
                <Box padding="400">
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        {t("snippetDetail.sections.previewResult", {
                          defaultValue: "Preview result",
                        })}
                      </Text>
                      {previewing && <Spinner size="small" />}
                    </InlineStack>

                    {!previewResult ? (
                      <EmptyState
                        heading={t("snippetDetail.preview.noneYet", {
                          defaultValue: "No preview yet",
                        })}
                        image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                      >
                        <p>
                          {t("snippetDetail.preview.runToInspect", {
                            defaultValue:
                              "Run a preview to inspect the normalized output and rule mapping.",
                          })}
                        </p>
                      </EmptyState>
                    ) : (
                      <BlockStack gap="300">
                        {!previewResult.matched && (
                          <Banner
                            tone="warning"
                            title={t("snippetDetail.preview.noMatchTitle", {
                              defaultValue:
                                "Conditions did not match this product",
                            })}
                          >
                            <p>
                              {t("snippetDetail.preview.noMatchMessage", {
                                defaultValue:
                                  "The snippet evaluated successfully, but the preview product did not meet the rule conditions.",
                              })}
                            </p>
                          </Banner>
                        )}

                        {previewResult.hasOutput ? (
                          <>
                            <BlockStack gap="150">
                              <Text variant="headingSm">
                                {t("snippetDetail.preview.normalizedOutput", {
                                  defaultValue: "Normalized output",
                                })}
                              </Text>
                              <Box
                                as="pre"
                                background="bg-surface-secondary"
                                padding="300"
                                borderRadius="200"
                                overflowX="auto"
                              >
                                {normalizedOutputJson}
                              </Box>
                            </BlockStack>

                            <BlockStack gap="150">
                              <Text variant="headingSm">
                                {t("snippetDetail.preview.ruleMapping", {
                                  defaultValue: "Bulk rule mapping",
                                })}
                              </Text>
                              <Box
                                as="pre"
                                background="bg-surface-secondary"
                                padding="300"
                                borderRadius="200"
                                overflowX="auto"
                              >
                                {rulePreviewJson}
                              </Box>
                            </BlockStack>
                          </>
                        ) : (
                          <EmptyState
                            heading={t("snippetDetail.preview.noOutput", {
                              defaultValue: "No output returned",
                            })}
                            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                          >
                            <p>
                              {t("snippetDetail.preview.noOutputMessage", {
                                defaultValue:
                                  "This snippet resolved without any editable output for the selected product.",
                              })}
                            </p>
                          </EmptyState>
                        )}
                      </BlockStack>
                    )}
                  </BlockStack>
                </Box>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>

      <Modal
        open={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        title={t("snippetDetail.archiveModal.title", {
          defaultValue: "Archive snippet",
        })}
        primaryAction={{
          content: t("snippetDetail.actions.archive", {
            defaultValue: "Archive",
          }),
          destructive: true,
          onAction: handleArchive,
          loading: saving,
        }}
        secondaryActions={[
          {
            content: t("snippetDetail.actions.cancel", {
              defaultValue: "Cancel",
            }),
            onAction: () => setShowDeleteModal(false),
          },
        ]}
      >
        <Modal.Section>
          <Text>
            {t("snippetDetail.archiveModal.description", {
              defaultValue:
                "Archived snippets stay available for reference, but they are removed from active editing workflows.",
            })}
          </Text>
        </Modal.Section>
      </Modal>
    </>
  );
}
