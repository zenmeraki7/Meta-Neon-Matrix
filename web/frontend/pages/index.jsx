import { Suspense, lazy } from "react";
import { Card, Page, SkeletonBodyText, Box } from "@shopify/polaris";
import { useTranslation } from "react-i18next";

const DashboardPage = lazy(() =>
  import("../Domain/dashboard/pages/DashboardPage"),
);

export default function Index() {
  const { t } = useTranslation();

  return (
    <Suspense
      fallback={
        <Page title={t("dashboard", { defaultValue: "Dashboard" })}>
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
