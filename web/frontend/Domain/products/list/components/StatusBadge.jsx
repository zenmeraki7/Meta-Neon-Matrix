// src/components/products/StatusBadge.jsx

import React, { memo } from "react";
import { Badge } from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import { getStatusColor } from "../utils/productHelpers";

const StatusBadge = memo(function StatusBadge({ status }) {
  const { t } = useTranslation("products");
  const normalizedStatus = status != null ? String(status).toUpperCase() : "";
  const tone = getStatusColor(normalizedStatus);
  const label = normalizedStatus
    ? t(`productStatus.${normalizedStatus}`, normalizedStatus)
    : t("productStatus.UNKNOWN", "Unknown");

  return <Badge tone={tone}>{label}</Badge>;
});

export default StatusBadge;
