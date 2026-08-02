/**
 * web/services/billingReconciliationService.js
 *
 * Shared helpers for authoritative billing reconciliation.
 *
 * Both the HTTP sync endpoint (syncBillingController) and the
 * APP_SUBSCRIPTIONS_UPDATE webhook use this module so that the
 * fail-closed logic lives in exactly one place.
 */

import { db } from "../repositories/repositoryDb.js";
import logger from "../utils/loggerUtils.js";

/**
 * Maps a resolved billing state (from resolveBillingStateFromActiveSubscriptions)
 * to the Prisma Subscription upsert/update payload fields.
 *
 * @param {object} state - Resolved billing state object.
 * @param {BigInt|number|null} currentVersion - Current billingAuthorityVersion from the DB row,
 *   or null when upserting a brand-new row (version will start at 1).
 * @returns {object} Prisma data payload.
 */
export function toSubscriptionRecord(state, currentVersion = null) {
  const isFree = !state.subscriptionId || state.status !== "ACTIVE";

  const base = {
    status: isFree ? "FREE" : "ACTIVE",
    planKey: state.planKey ?? "FREE",
    planName: state.planName ?? "Free Plan",
    subscriptionId: isFree ? null : (state.subscriptionId ?? null),
    currentPeriodEnd: null, // refreshed by Shopify API; not carried through resolved state
    trialEndsAt: null,
    pendingSubscriptionId: null,
    pendingPlanKey: null,
    pendingPlanName: null,
    billingAuthorityVersion:
      currentVersion !== null
        ? { increment: 1 }
        : BigInt(1),
    billingReconciledAt: new Date(),
  };

  return base;
}

/**
 * Performs an authoritative billing reconciliation for a shop.
 *
 * For an existing row this is a compare-and-swap: the update only succeeds if
 * the row's billingAuthorityVersion still matches expectedVersion. If Prisma
 * updateMany returns count === 0 the caller must retry or surface the conflict.
 *
 * For a brand-new shop (no existing row) an upsert creates the initial record.
 *
 * @param {object} options
 * @param {string} options.shop
 * @param {object} options.state - Resolved billing state from resolveBillingStateFromActiveSubscriptions.
 * @param {object|null} options.existingRow - Current DB subscription row, or null.
 * @param {object} [options.tx] - Optional Prisma transaction client. Defaults to db.
 * @returns {{ applied: boolean, reason: string }}
 */
export async function applyBillingReconciliation({ shop, state, existingRow, tx }) {
  const client = tx ?? db;

  if (!existingRow) {
    // No existing row — create with version 1.
    await client.subscription.upsert({
      where: { shop },
      create: {
        shop,
        ...toSubscriptionRecord(state, null),
      },
      update: toSubscriptionRecord(state, null),
    });

    logger.info("Billing reconciliation: created initial subscription row", {
      shop,
      status: state.status,
      planKey: state.planKey,
    });

    return { applied: true, reason: "CREATED" };
  }

  const expectedVersion = existingRow.billingAuthorityVersion;

  const result = await client.subscription.updateMany({
    where: {
      shop,
      billingAuthorityVersion: expectedVersion,
    },
    data: toSubscriptionRecord(state, expectedVersion),
  });

  if (result.count !== 1) {
    logger.warn("Billing reconciliation: CAS conflict — version mismatch, not applied", {
      shop,
      expectedVersion: String(expectedVersion),
    });
    return { applied: false, reason: "CAS_CONFLICT" };
  }

  logger.info("Billing reconciliation: CAS write applied", {
    shop,
    expectedVersion: String(expectedVersion),
    nextVersion: String(BigInt(expectedVersion) + BigInt(1)),
    status: state.status,
    planKey: state.planKey,
    subscriptionId: state.subscriptionId ?? null,
  });

  return { applied: true, reason: "UPDATED" };
}
