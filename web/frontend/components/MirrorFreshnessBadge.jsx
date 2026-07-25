import React from "react";
import { Badge, InlineStack, Text, Tooltip } from "@shopify/polaris";
import { useTranslation } from "react-i18next";

export default function MirrorFreshnessBadge({ isSyncInProgress = false }) {
    const { t } = useTranslation();
  const tone = isSyncInProgress ? "warning" : "success";
  const label = isSyncInProgress ? "Mirror syncing" : "Mirror fresh";

  return (
    <Tooltip content={t("mirrorFreshness.tooltip")}>
      <InlineStack gap={"200"} blockAlign={"center"}>
        <Badge tone={tone}>{label}</Badge>
        <Text as={"span"} variant={"bodySm"} tone={"subdued"}>
            {t("mirrorFreshness.sourceOfTruth")}
       
        </Text>
      </InlineStack>
    </Tooltip>
  );
}
