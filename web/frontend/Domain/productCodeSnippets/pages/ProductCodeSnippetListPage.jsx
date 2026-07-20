import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  InlineStack,
  Layout,
  Page,
  Select,
  SkeletonBodyText,
  SkeletonDisplayText,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAuthenticatedFetch } from "../../../hooks/useAuthenticatedFetch";
import { listProductCodeSnippets } from "../services/productCodeSnippetService";

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

export default function ProductCodeSnippetListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fetchFn = useAuthenticatedFetch();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [snippets, setSnippets] = useState([]);
  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    []
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
    }, 300);

    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const load = async () => {
      setLoading(true);
      setError("");

      try {
        const data = await listProductCodeSnippets(
          fetchFn,
          {
            search,
            status,
          },
          {
            signal: controller.signal,
          }
        );

        if (active) {
          setSnippets(data);
        }
      } catch (err) {
        if (err?.name === "AbortError") {
          return;
        }
        if (active) {
          setError(
            err.message ||
              t("snippetList.errors.load", {
                defaultValue: "Failed to load snippets",
              })
          );
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [fetchFn, search, status, t]);

  const formatUpdatedAt = useMemo(
    () => (value) => {
      if (!value) {
        return t("snippetList.never", { defaultValue: "Never" });
      }
      return dateTimeFormatter.format(new Date(value));
    },
    [dateTimeFormatter, t]
  );

  const emptyState = useMemo(() => {
    if (search || status) {
      return {
        heading: t("snippetList.empty.filteredHeading", {
          defaultValue: "No snippets match these filters",
        }),
        action: {
          content: t("snippetList.actions.clearFilters", {
            defaultValue: "Clear filters",
          }),
          onAction: () => {
            setSearch("");
            setSearchInput("");
            setStatus("");
          },
        },
        image:
          "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png",
      };
    }

    return {
      heading: t("snippetList.empty.firstHeading", {
        defaultValue: "Create your first logic snippet",
      }),
      action: {
        content: t("snippetList.actions.new", {
          defaultValue: "New snippet",
        }),
        onAction: () => navigate("/product-code-snippets/new"),
      },
      image:
        "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png",
    };
  }, [navigate, search, status, t]);

  return (
    <Page
      title={t("snippetList.title", { defaultValue: "Snippet Studio" })}
      subtitle={t("snippetList.subtitle", {
        defaultValue:
          "Build reusable product logic snippets with safe previewing against your product mirror.",
      })}
      primaryAction={{
        content: t("snippetList.actions.new", {
          defaultValue: "New snippet",
        }),
        onAction: () => navigate("/product-code-snippets/new"),
      }}
      fullWidth
    >
      <Layout>
        <Layout.Section>
          <Card>
            <Box padding="400">
              <InlineStack gap="300" wrap>
                <Box minWidth="320px">
                  <TextField
                    label={t("snippetList.filters.searchLabel", {
                      defaultValue: "Search snippets",
                    })}
                    labelHidden
                    value={searchInput}
                    onChange={setSearchInput}
                    placeholder={t("snippetList.filters.searchPlaceholder", {
                      defaultValue: "Search by snippet title",
                    })}
                    autoComplete="off"
                  />
                </Box>
                <Box minWidth="220px">
                  <Select
                    label={t("snippetList.filters.statusLabel", {
                      defaultValue: "Status",
                    })}
                    labelHidden
                    value={status}
                    onChange={setStatus}
                    options={[
                      {
                        label: t("snippetList.status.all", {
                          defaultValue: "All statuses",
                        }),
                        value: "",
                      },
                      {
                        label: t("snippetList.status.active", {
                          defaultValue: "Active",
                        }),
                        value: "ACTIVE",
                      },
                      {
                        label: t("snippetList.status.draft", {
                          defaultValue: "Draft",
                        }),
                        value: "DRAFT",
                      },
                      {
                        label: t("snippetList.status.archived", {
                          defaultValue: "Archived",
                        }),
                        value: "ARCHIVED",
                      },
                    ]}
                  />
                </Box>
              </InlineStack>
            </Box>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Box padding="400">
              {loading ? (
                <BlockStack gap="400">
                  <SkeletonDisplayText size="small" />
                  <SkeletonBodyText lines={6} />
                </BlockStack>
              ) : error ? (
                <Text tone="critical">{error}</Text>
              ) : snippets.length === 0 ? (
                <EmptyState {...emptyState} />
              ) : (
                <BlockStack gap="0">
                  {snippets.map((snippet, index) => (
                    <Box
                      key={snippet.id}
                      paddingBlock={index === 0 ? "0" : "400"}
                      borderBlockStartWidth={index === 0 ? "0" : "025"}
                      borderColor="border"
                    >
                      <InlineStack
                        align="space-between"
                        blockAlign="start"
                        gap="400"
                      >
                        <BlockStack gap="150">
                          <InlineStack gap="200" blockAlign="center">
                            <Button
                              variant="plain"
                              textAlign="left"
                              onClick={() =>
                                navigate(`/product-code-snippets/${snippet.id}`)
                              }
                            >
                              {snippet.title}
                            </Button>
                            <Badge tone={getStatusTone(snippet.status)}>
                              {t(
                                `snippetList.status.${String(
                                  snippet.status || ""
                                ).toLowerCase()}`,
                                { defaultValue: snippet.status }
                              )}
                            </Badge>
                          </InlineStack>
                          <Text tone="subdued" variant="bodySm">
                            {t("snippetList.updated", {
                              defaultValue:
                                "{{language}} • Updated {{updatedAt}}",
                              language: snippet.language,
                              updatedAt: formatUpdatedAt(snippet.updatedAt),
                            })}
                          </Text>
                          <Text tone="subdued" variant="bodySm">
                            {t("snippetList.validation", {
                              defaultValue: "Validation: {{status}}",
                              status:
                                snippet.lastValidationStatus ||
                                t("snippetList.validationNotRun", {
                                  defaultValue: "Not run",
                                }),
                            })}
                          </Text>
                        </BlockStack>

                        <Button
                          onClick={() =>
                            navigate(`/product-code-snippets/${snippet.id}`)
                          }
                        >
                          {t("snippetList.actions.open", {
                            defaultValue: "Open",
                          })}
                        </Button>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              )}
            </Box>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
