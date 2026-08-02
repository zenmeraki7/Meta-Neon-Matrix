import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Shopify App Home web component type definitions are declared for JSX", () => {
  const dts = read("web/frontend/types/shopify-app-home-elements.d.ts");

  for (const tag of ["s-page", "s-section", "s-button", "s-text", "s-banner", "s-badge", "s-box", "s-link"]) {
    assert.match(dts, new RegExp(`"${tag}":`));
  }
});

test("Polaris App Home web component adapter exports React wrappers for s-* tags", () => {
  const adapter = read("web/frontend/components/PolarisAppHome/webComponentAdapter.jsx");
  const barrel = read("web/frontend/components/PolarisAppHome/index.js");

  for (const component of ["SPage", "SSection", "SButton", "SText", "SBanner", "SBadge", "SBox"]) {
    assert.match(adapter, new RegExp(`export function ${component}`));
    assert.match(barrel, new RegExp(component));
  }

  assert.match(adapter, /<s-page/);
  assert.match(adapter, /<s-section/);
  assert.match(adapter, /<s-button/);
  assert.match(adapter, /<s-text/);
  assert.match(adapter, /<s-banner/);
});

test("App.jsx and PlanStatus.jsx adopt Polaris App Home web component architecture", () => {
  const app = read("web/frontend/App.jsx");
  const planStatus = read("web/frontend/Domain/dashboard/components/PlanStatus.jsx");

  assert.match(app, /<s-page/);
  assert.match(app, /<s-section/);
  assert.match(app, /<s-banner/);

  assert.match(planStatus, /<s-banner/);
  assert.match(planStatus, /<s-text/);
});

test("index.html loads Shopify App Bridge runtime script for custom web elements", () => {
  const html = read("web/frontend/index.html");
  assert.match(html, /https:\/\/cdn\.shopify\.com\/shopifycloud\/app-bridge\.js/);
  assert.match(html, /https:\/\/cdn\.shopify\.com\/shopifycloud\/polaris\.js/);
});
