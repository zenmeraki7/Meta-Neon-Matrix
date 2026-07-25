// web/frontend/components/GenericErrorFallback.jsx
import React from "react";
import { Card, Box, Button, Text } from "@shopify/polaris";
import { useTranslation } from "react-i18next";

export default function GenericErrorFallback({ error, resetErrorBoundary }) {
  const { t } = useTranslation();
  return (
    <Card sectioned>
      <Text as="p" variant="bodyMd">
        {t("common.somethingWentWrong", "Something went wrong.")}{" "}
        {import.meta.env.DEV && error?.message && (
          <Text as="span" color="subdued">
            ({error.message})
          </Text>
        )}
      </Text>
      <Box paddingBlockStart="200">
        <Button onClick={resetErrorBoundary} size="slim">
          {t("common.retry", "Retry")}
        </Button>
      </Box>
    </Card>
  );
}
