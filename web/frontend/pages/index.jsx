import { Suspense, lazy } from "react";
import { Card, Page, SkeletonBodyText, Box } from "@shopify/polaris";

const DashboardPage = lazy(() =>
  import("../Domain/dashboard/pages/DashboardPage"),
);

export default function Index() {
  return (
    <Suspense
      fallback={
        <Page title="Dashboard">
          <Card roundedAbove="sm">
            <Box padding="500">
              <SkeletonBodyText lines={6} />
            </Box>
          </Card>
        </Page>
      }
    >
      <DashboardPage />
    </Suspense>
  );
}
