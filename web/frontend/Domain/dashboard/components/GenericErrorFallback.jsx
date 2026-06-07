// web/frontend/components/GenericErrorFallback.jsx
import React, { useEffect } from "react";
import { Card, Box, Text } from "@shopify/polaris";
import DegradationBanner from "../../../components/DegradationBanner";

export default function GenericErrorFallback({ error, resetErrorBoundary }) {
  useEffect(() => {
    const timer = window.setTimeout(resetErrorBoundary, 30_000);
    return () => window.clearTimeout(timer);
  }, [resetErrorBoundary]);

  return (
    <Card sectioned>
      <DegradationBanner fallbackCode="JOB_SUSPENDED" tone="warning" />
      {import.meta.env.DEV && error?.message && (
        <Box paddingBlockStart="200">
          <Text as="span" color="subdued">
            ({error.message})
          </Text>
        </Box>
      )}
    </Card>
  );
}
