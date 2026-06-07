import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file) => fs.readFileSync(path.resolve(file), "utf8");

test("bulk edit status projection and DTO expose degradation metadata", () => {
  const projection = read("web/services/historyStatusProjectionService.js");
  const dto = read("web/dtos/historyDto.js");
  assert.ok(projection.includes("degradationFromHistory"));
  assert.ok(projection.includes("key: \"suspended\""));
  assert.ok(dto.includes("toDegradationDto"));
  assert.ok(dto.includes("degradation: toDegradationDto"));
});

test("merchant bulk-edit surfaces render the shared degradation banner", () => {
  const preview = read("web/frontend/Domain/products/edit/pages/EditPreviewPage.jsx");
  const details = read("web/frontend/Domain/products/edit/pages/EditDetails.jsx");
  const routeBoundary = read("web/frontend/components/Error/AppRouteErrorBoundary.jsx");
  const tableBoundary = read("web/frontend/components/Error/TableErrorBoundary.jsx");
  const cellBoundary = read("web/frontend/components/Error/CellErrorBoundary.jsx");
  assert.ok(preview.includes("fallbackCode=\"MIRROR_UNSAFE\""));
  assert.ok(details.includes("supportStatus.degradation"));
  assert.ok(routeBoundary.includes("retry automatically in 30 seconds"));
  assert.ok(routeBoundary.includes("No action needed."));
  assert.ok(tableBoundary.includes("DegradationBanner"));
  assert.ok(cellBoundary.includes("Expected recovery: within a few minutes"));
  assert.ok(cellBoundary.includes("No action needed."));
});
