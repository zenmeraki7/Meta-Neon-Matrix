import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "./config/database.js";
import {
  getOperationSummaryByShop,
  getSubscriptionPlanSnapshotByShop,
} from "./repositories/bootstrapRepository.js";

test("bootstrapRepository operation summary queries are shop-scoped", async () => {
  const originalCount = prisma.editHistory.count;
  const originalFindFirst = prisma.editHistory.findFirst;

  const captured = [];

  prisma.editHistory.count = async (args) => {
    captured.push({ method: "count", args });
    return 2;
  };
  prisma.editHistory.findFirst = async (args) => {
    captured.push({ method: "findFirst", args });
    return null;
  };

  try {
    await getOperationSummaryByShop("demo-shop.myshopify.com");
  } finally {
    prisma.editHistory.count = originalCount;
    prisma.editHistory.findFirst = originalFindFirst;
  }

  assert.equal(captured.length, 2);
  for (const call of captured) {
    assert.equal(
      call.args?.where?.shop,
      "demo-shop.myshopify.com",
      `${call.method} query must include where.shop predicate`,
    );
  }
});

test("bootstrapRepository subscription snapshot query is shop-scoped", async () => {
  const originalFindFirst = prisma.subscription.findFirst;
  let capturedArgs = null;

  prisma.subscription.findFirst = async (args) => {
    capturedArgs = args;
    return { planKey: "FREE", status: "ACTIVE" };
  };

  try {
    await getSubscriptionPlanSnapshotByShop("tenant-a.myshopify.com");
  } finally {
    prisma.subscription.findFirst = originalFindFirst;
  }

  assert.equal(
    capturedArgs?.where?.shop,
    "tenant-a.myshopify.com",
    "subscription query must include where.shop predicate",
  );
});
