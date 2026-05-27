import { Suspense, lazy } from "react";

const DashboardPage = lazy(() =>
  import("../Domain/dashboard/pages/DashboardPage"),
);

export default function Index() {
  return (
    <Suspense fallback={<div className="embedded-context-error">Loading dashboard...</div>}>
      <DashboardPage />
    </Suspense>
  );
}
