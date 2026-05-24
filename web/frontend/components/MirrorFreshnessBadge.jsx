import React from "react";
import { Badge, InlineStack, Text, Tooltip } from "@shopify/polaris";

export default function MirrorFreshnessBadge({ isSyncInProgress = false }) {
  const tone = isSyncInProgress ? "warning" : "success";
  const label = isSyncInProgress ? "Mirror syncing" : "Mirror fresh";

  return (
    <Tooltip content="Preview and targeting use the app mirror snapshot. Shopify Admin remains the final source of truth for live catalog state.">
      <InlineStack gap="200" blockAlign="center">
        <Badge tone={tone}>{label}</Badge>
        <Text as="span" variant="bodySm" tone="subdued">
          Source of truth: Shopify
        </Text>
      </InlineStack>
    </Tooltip>
  );
}
