import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("web/services/productService/productQueryCommandService.js", "utf8");

test("product query uses cooled-down stale sync recovery", () => {
  assert.match(source, /import \{ maybeRecoverStaleSync \} from "\.\.\/syncStatusQueryService\.js"/);
  assert.match(source, /await maybeRecoverStaleSync\(shop\)/);
  assert.doesNotMatch(source, /recoverStaleProductSyncStateByShop/);
});
