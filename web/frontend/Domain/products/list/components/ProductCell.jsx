// src/components/products/ProductCell.jsx

import React, { memo } from "react";
import { InlineStack, Box, Thumbnail, Text } from "@shopify/polaris";

const ProductCell = memo(function ProductCell({
  title = "",
  handle = "",
  imageUrl = "",
}) {
  const thumbnailAlt = title ? `Product image for ${title}` : "";

  return (
    <InlineStack gap="300" blockAlign="center" wrap={false}>
      <Box minWidth="40px">
        <Thumbnail
          source={imageUrl || undefined}
          alt={thumbnailAlt}
          size="small"
        />
      </Box>

      <Box minWidth="0">
        <Text as="p" fontWeight="medium" truncate>
          {title}
        </Text>

        {handle && (
          <Text as="p" tone="subdued" variant="bodySm" truncate>
            {handle}
          </Text>
        )}
      </Box>
    </InlineStack>
  );
});

export default ProductCell;
