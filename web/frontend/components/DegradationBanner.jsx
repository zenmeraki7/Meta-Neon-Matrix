import React from "react";
import { Banner, BlockStack, Text } from "@shopify/polaris";
import {
  formatExpectedRecovery,
  getDegradationContract,
} from "../utils/degradationContract";

export default function DegradationBanner({
  degradation,
  fallbackCode = "JOB_SUSPENDED",
  tone = "warning",
}) {
  const contract = getDegradationContract(degradation, fallbackCode);
  return (
    <Banner tone={tone} title={contract.title}>
      <BlockStack gap="100">
        <Text as="p">{contract.body}</Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {formatExpectedRecovery(contract)}
        </Text>
      </BlockStack>
    </Banner>
  );
}
