import { Page, Card, BlockStack, SkeletonBodyText, SkeletonDisplayText, Box } from "@shopify/polaris";

export default function PageLoader() {
  return (
    <Page>
      <Card>
        <BlockStack gap="400">
          <Box minHeight="520px">
            <SkeletonDisplayText size="small" />
            <SkeletonBodyText lines={10} />
          </Box>
        </BlockStack>
      </Card>
    </Page>
  );
}
