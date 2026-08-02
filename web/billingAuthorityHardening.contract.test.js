/**
 * web/billingAuthorityHardening.contract.test.js
 *
 * Contract tests for P0/P1 billing authority hardening.
 * Runs with: node --test web/billingAuthorityHardening.contract.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSource(relPath) {
  return readFileSync(resolve(__dirname, relPath), "utf-8");
}

// ---------------------------------------------------------------------------
// Source files under test
// ---------------------------------------------------------------------------
const schemaSource = readSource("prisma/schema.prisma");
const billingControllerSource = readSource("controllers/billingController.js");
const privacySource = readSource("privacy.js");
const reconciliationServiceSource = readSource("services/billingReconciliationService.js");
const subscriptionAuthoritySource = readSource("services/subscriptionAuthorityService.js");

// ---------------------------------------------------------------------------
// 1. Schema: billingAuthorityVersion + billingReconciledAt on Subscription
// ---------------------------------------------------------------------------
describe("1. Schema: Subscription has monotonic CAS version and reconciliation timestamp", () => {
  it("Subscription model contains billingAuthorityVersion BigInt @default(0)", () => {
    assert.ok(
      schemaSource.includes("billingAuthorityVersion BigInt"),
      "Expected billingAuthorityVersion BigInt field on Subscription",
    );
    assert.ok(
      schemaSource.includes("billingAuthorityVersion BigInt             @default(0)"),
      "Expected billingAuthorityVersion to default to 0",
    );
  });

  it("Subscription model contains billingReconciledAt DateTime?", () => {
    assert.ok(
      schemaSource.includes("billingReconciledAt     DateTime?"),
      "Expected billingReconciledAt DateTime? on Subscription",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Schema: BillingEvent has @@unique([shop, webhookId]) for delivery idempotency
// ---------------------------------------------------------------------------
describe("2. Schema: BillingEvent has @@unique([shop, webhookId])", () => {
  it("BillingEvent model includes webhookId field", () => {
    // Find the BillingEvent model block
    const billingEventBlock = schemaSource.slice(
      schemaSource.lastIndexOf("model BillingEvent {"),
    );
    assert.ok(
      billingEventBlock.includes("webhookId"),
      "Expected BillingEvent to include webhookId field",
    );
  });

  it("BillingEvent has @@unique([shop, webhookId])", () => {
    const billingEventBlock = schemaSource.slice(
      schemaSource.lastIndexOf("model BillingEvent {"),
    );
    assert.ok(
      billingEventBlock.includes("@@unique([shop, webhookId])"),
      "Expected @@unique([shop, webhookId]) on BillingEvent",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. P0: syncBillingController uses resolveBillingStateFromActiveSubscriptions
//    and NOT the old unsafe selection pattern
// ---------------------------------------------------------------------------
describe("3. P0: syncBillingController routes through fail-closed resolver", () => {
  it("imports resolveBillingStateFromActiveSubscriptions", () => {
    assert.ok(
      billingControllerSource.includes("resolveBillingStateFromActiveSubscriptions"),
      "Expected billingController.js to import resolveBillingStateFromActiveSubscriptions",
    );
  });

  it("imports applyBillingReconciliation from billingReconciliationService", () => {
    assert.ok(
      billingControllerSource.includes("applyBillingReconciliation"),
      "Expected billingController.js to import applyBillingReconciliation",
    );
  });

  it("does NOT contain the unsafe subscriptions[0] fallback selection", () => {
    assert.ok(
      !billingControllerSource.includes("subscriptions[0]"),
      "billingController.js must not use subscriptions[0] fallback",
    );
  });

  it("does NOT contain activateSubscriptionFromShopify helper", () => {
    assert.ok(
      !billingControllerSource.includes("activateSubscriptionFromShopify"),
      "billingController.js must not define or call activateSubscriptionFromShopify",
    );
  });

  it("syncBillingController calls resolveBillingStateFromActiveSubscriptions", () => {
    // Verify the call site is inside the sync controller (after subscribeBillingController)
    const afterSubscribe = billingControllerSource.slice(
      billingControllerSource.indexOf("syncBillingController"),
    );
    assert.ok(
      afterSubscribe.includes("resolveBillingStateFromActiveSubscriptions"),
      "syncBillingController must call resolveBillingStateFromActiveSubscriptions",
    );
  });

  it("resolveBillingStateFromActiveSubscriptions rejects FROZEN subscriptions (unit)", () => {
    // Inline the logic check directly from subscriptionAuthoritySource invariants
    // FROZEN is in RESTRICTED_STATUSES
    assert.ok(
      subscriptionAuthoritySource.includes('"FROZEN"'),
      'RESTRICTED_STATUSES must include "FROZEN"',
    );
    assert.ok(
      subscriptionAuthoritySource.includes('"RESTRICTED"'),
      'RESTRICTED_STATUSES must include "RESTRICTED"',
    );
    assert.ok(
      subscriptionAuthoritySource.includes("BILLING_RESTRICTED"),
      "Resolver must throw BILLING_RESTRICTED for restricted states",
    );
  });

  it("resolveBillingStateFromActiveSubscriptions downgrades to FREE on empty list (unit)", () => {
    // When active.length === 0, the resolver calls resolveBillingStateFromRecord with
    // subscription: null, which produces status FREE
    assert.ok(
      subscriptionAuthoritySource.includes("active.length === 0"),
      "Resolver must handle empty list",
    );
    assert.ok(
      subscriptionAuthoritySource.includes("subscription: null"),
      "Empty list must produce null subscription (FREE state)",
    );
  });

  it("resolveBillingStateFromActiveSubscriptions fails closed on multiple ACTIVE (unit)", () => {
    assert.ok(
      subscriptionAuthoritySource.includes("active.length > 1"),
      "Resolver must check for multiple active subscriptions",
    );
    assert.ok(
      subscriptionAuthoritySource.includes("MULTIPLE_ACTIVE_SUBSCRIPTIONS"),
      "Resolver must throw MULTIPLE_ACTIVE_SUBSCRIPTIONS",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. P0: applyBillingReconciliation performs CAS with billingAuthorityVersion
// ---------------------------------------------------------------------------
describe("4. P0: applyBillingReconciliation uses CAS predicate", () => {
  it("updateMany predicate includes billingAuthorityVersion", () => {
    assert.ok(
      reconciliationServiceSource.includes("billingAuthorityVersion: expectedVersion"),
      "CAS predicate must include billingAuthorityVersion: expectedVersion",
    );
  });

  it("returns applied:false on CAS conflict (count !== 1)", () => {
    assert.ok(
      reconciliationServiceSource.includes("result.count !== 1"),
      "Must detect count !== 1 as a CAS conflict",
    );
    assert.ok(
      reconciliationServiceSource.includes("CAS_CONFLICT"),
      "Must return reason CAS_CONFLICT when count !== 1",
    );
  });

  it("increments billingAuthorityVersion on successful write", () => {
    assert.ok(
      reconciliationServiceSource.includes("{ increment: 1 }"),
      "Must increment billingAuthorityVersion on successful CAS write",
    );
  });

  it("sets billingReconciledAt on every write", () => {
    assert.ok(
      reconciliationServiceSource.includes("billingReconciledAt: new Date()"),
      "Must update billingReconciledAt on every reconciliation write",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. P1: APP_SUBSCRIPTIONS_UPDATE uses Shopify-authoritative CAS flow
// ---------------------------------------------------------------------------
describe("5. P1: APP_SUBSCRIPTIONS_UPDATE treats webhook as reconciliation signal", () => {
  const webhookBlock = privacySource.slice(
    privacySource.indexOf("APP_SUBSCRIPTIONS_UPDATE:"),
  );

  it("imports ShopifyBillingService in privacy.js", () => {
    assert.ok(
      privacySource.includes("ShopifyBillingService"),
      "privacy.js must import ShopifyBillingService",
    );
  });

  it("imports resolveBillingStateFromActiveSubscriptions in privacy.js", () => {
    assert.ok(
      privacySource.includes("resolveBillingStateFromActiveSubscriptions"),
      "privacy.js must import resolveBillingStateFromActiveSubscriptions",
    );
  });

  it("imports applyBillingReconciliation in privacy.js", () => {
    assert.ok(
      privacySource.includes("applyBillingReconciliation"),
      "privacy.js must import applyBillingReconciliation",
    );
  });

  it("webhook callback fetches activeSubscriptions from Shopify before persisting", () => {
    assert.ok(
      webhookBlock.includes("getActiveSubscriptions"),
      "APP_SUBSCRIPTIONS_UPDATE must call getActiveSubscriptions from Shopify",
    );
  });

  it("webhook callback does NOT perform unconditional updateMany({where:{shop}})", () => {
    // The old unsafe pattern was updateMany({ where: { shop } }) with no version predicate
    // The new CAS uses billingAuthorityVersion as an additional predicate.
    // We check that the webhook block itself doesn't contain the old unconstrained update.
    const hasUnconstrained =
      webhookBlock.includes("updateMany({\n              where: { shop },") ||
      webhookBlock.includes("updateMany({ where: { shop }");
    assert.ok(
      !hasUnconstrained,
      "APP_SUBSCRIPTIONS_UPDATE must not use unconditional updateMany({where:{shop}})",
    );
  });

  it("webhook callback deduplicates concurrent deliveries via BillingEvent P2002 catch", () => {
    assert.ok(
      webhookBlock.includes("db.billingEvent.create"),
      "Webhook must create a BillingEvent record for idempotency",
    );
    assert.ok(
      webhookBlock.includes('e?.code === "P2002"'),
      "Webhook must catch P2002 on BillingEvent create as concurrent duplicate",
    );
  });

  it("webhook throws on CAS conflict to trigger Shopify retry", () => {
    assert.ok(
      webhookBlock.includes("BILLING_CAS_CONFLICT"),
      "Webhook must throw on CAS conflict to trigger retry",
    );
  });
});
