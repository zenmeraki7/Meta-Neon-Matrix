import test from "node:test";
import assert from "node:assert/strict";

import { reserveAutomaticRuleApplications } from "./services/automaticRuleApplicationReservationService.js";

test("reserveAutomaticRuleApplications keeps sibling variants isolated under same product", async () => {
  const createdRows = [];
  const createApplication = async (data) => {
    createdRows.push(data);
    return { id: `mock-${createdRows.length}`, ...data };
  };

  const rule = { id: "rule-1", shop: "shop-a" };
  const run = { id: "run-1", triggerReference: "webhook-ref" };
  const product = { id: "P1" };
  const candidateTargets = [
    {
      targetResourceType: "VARIANT",
      targetIdentity: "VARIANT:V1",
      productId: "P1",
      variantId: "V1",
      product,
    },
    {
      targetResourceType: "VARIANT",
      targetIdentity: "VARIANT:V3",
      productId: "P1",
      variantId: "V3",
      product,
    },
  ];

  const result = await reserveAutomaticRuleApplications({
    createApplication,
    rule,
    run,
    candidateTargets,
    candidateProducts: [product],
    appliedStateUpdates: [
      {
        targetResourceType: "VARIANT",
        targetIdentity: "VARIANT:V1",
        productId: "P1",
        variantId: "V1",
        lastFingerprint: "fp-v1",
      },
      {
        targetResourceType: "VARIANT",
        targetIdentity: "VARIANT:V3",
        productId: "P1",
        variantId: "V3",
        lastFingerprint: "fp-v3",
      },
    ],
  });

  assert.equal(createdRows.length, 2);
  assert.deepEqual(
    createdRows.map((row) => row.targetIdentity).sort(),
    ["VARIANT:V1", "VARIANT:V3"],
  );
  assert.ok(createdRows.every((row) => row.targetResourceType === "VARIANT"));
  assert.ok(createdRows.every((row) => row.productId === "P1"));
  assert.deepEqual(
    createdRows.map((row) => row.variantId).sort(),
    ["V1", "V3"],
  );
  assert.equal(result.acceptedProducts.length, 1);
  assert.equal(result.acceptedProducts[0].id, "P1");
  assert.equal(result.acceptedTargets.length, 2);
  assert.deepEqual(
    result.acceptedTargets.map((target) => target.targetIdentity).sort(),
    ["VARIANT:V1", "VARIANT:V3"],
  );
  assert.deepEqual(result.skippedProducts, []);
});
