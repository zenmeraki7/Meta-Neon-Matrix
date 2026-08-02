import crypto from "crypto";
import { db } from "../repositories/repositoryDb.js";

function positiveBigInt(value, code = "USAGE_AMOUNT_INVALID") {
  let amount;
  try {
    amount = BigInt(value);
  } catch {
    amount = 0n;
  }
  if (amount <= 0n) {
    const error = new Error(code);
    error.code = "VALIDATION_FAILED";
    throw error;
  }
  return amount;
}

function periodBounds(subscription, now = new Date()) {
  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const authorityEnd = subscription?.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd)
    : null;
  return {
    periodStartsAt: startsAt,
    periodEndsAt: authorityEnd && authorityEnd > now ? authorityEnd : nextMonth,
  };
}

export async function reserveUsageInTransaction({
  tx,
  shop,
  entitlementKey,
  operationType,
  operationId,
  amount,
  idempotencyKey,
  expectedBillingAuthorityVersion,
  limit = null,
}) {
  if (!tx || !shop || !entitlementKey || !operationType || !operationId || !idempotencyKey) {
    throw new Error("USAGE_RESERVATION_SCOPE_REQUIRED");
  }
  const reserveAmount = positiveBigInt(amount);
  const expectedVersion = BigInt(expectedBillingAuthorityVersion ?? -1);
  const idempotencyKeyHash = crypto
    .createHash("sha256")
    .update(String(idempotencyKey), "utf8")
    .digest("hex");

  const subscriptions = await tx.$queryRaw`
    SELECT "billingAuthorityVersion", "currentPeriodEnd"
    FROM "Subscription"
    WHERE "shop" = ${shop}
    FOR UPDATE
  `;
  const subscription = subscriptions?.[0];
  if (!subscription || BigInt(subscription.billingAuthorityVersion) !== expectedVersion) {
    const error = new Error("BILLING_AUTHORITY_VERSION_MISMATCH");
    error.code = "BILLING_AUTHORITY_VERSION_MISMATCH";
    throw error;
  }

  const { periodStartsAt, periodEndsAt } = periodBounds(subscription);
  const period = await tx.usagePeriod.upsert({
    where: {
      shop_entitlementKey_periodStartsAt_periodEndsAt: {
        shop,
        entitlementKey,
        periodStartsAt,
        periodEndsAt,
      },
    },
    create: {
      shop,
      entitlementKey,
      periodStartsAt,
      periodEndsAt,
      billingAuthorityVersion: expectedVersion,
    },
    update: {},
  });

  const existing = await tx.usageReservation.findFirst({
    where: { shop, operationType, operationId, entitlementKey },
  });
  if (existing) return existing;

  if (limit !== null && limit !== undefined) {
    const usageLimit = BigInt(limit);
    if (period.reservedAmount - period.releasedAmount + reserveAmount > usageLimit) {
      const error = new Error("USAGE_LIMIT_EXCEEDED");
      error.code = "USAGE_LIMIT_EXCEEDED";
      throw error;
    }
  }

  const reservation = await tx.usageReservation.create({
    data: {
      id: crypto.randomUUID(),
      shop,
      periodId: period.id,
      entitlementKey,
      operationType,
      operationId,
      reservedAmount: reserveAmount,
      idempotencyKeyHash,
      subscriptionVersion: expectedVersion,
    },
  });
  await tx.usageLedgerEntry.create({
    data: {
      id: crypto.randomUUID(),
      shop,
      usagePeriodId: period.id,
      reservationId: reservation.id,
      entitlementKey,
      operationType,
      operationId,
      entryType: "RESERVED",
      amount: reserveAmount,
      idempotencyKey: `${idempotencyKey}:reserved`,
      billingAuthorityVersion: expectedVersion,
    },
  });
  await tx.usagePeriod.updateMany({
    where: { shop, id: period.id, billingAuthorityVersion: expectedVersion },
    data: { reservedAmount: { increment: reserveAmount } },
  });
  return reservation;
}

async function settleUsage({
  shop,
  operationType,
  operationId,
  entitlementKey,
  amount,
  idempotencyKey,
  entryType,
  dbClient = db,
}) {
  return dbClient.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM "UsageReservation"
      WHERE "shop"=${shop} AND "operationType"=${operationType}
        AND "operationId"=${operationId} AND "entitlementKey"=${entitlementKey}
      FOR UPDATE
    `;
    const reservation = rows?.[0];
    if (!reservation) throw new Error("USAGE_RESERVATION_NOT_FOUND");
    const remaining = BigInt(reservation.reservedAmount)
      - BigInt(reservation.consumedAmount)
      - BigInt(reservation.releasedAmount);
    const settlementAmount = amount == null ? remaining : positiveBigInt(amount);
    if (settlementAmount > remaining) throw new Error("USAGE_SETTLEMENT_EXCEEDS_RESERVATION");

    const inserted = await tx.usageLedgerEntry.createMany({
      data: [{
        id: crypto.randomUUID(),
        shop,
        usagePeriodId: reservation.periodId,
        reservationId: reservation.id,
        entitlementKey,
        operationType,
        operationId,
        entryType,
        amount: settlementAmount,
        idempotencyKey,
        billingAuthorityVersion: reservation.subscriptionVersion,
      }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return reservation;

    const isConsume = entryType === "CONSUMED";
    const settled = await tx.usageReservation.updateMany({
      where: {
        id: reservation.id,
        shop,
        consumedAmount: reservation.consumedAmount,
        releasedAmount: reservation.releasedAmount,
      },
      data: isConsume
        ? { consumedAmount: { increment: settlementAmount }, consumedAt: new Date(), status: settlementAmount === remaining ? "CONSUMED" : "PARTIALLY_CONSUMED" }
        : { releasedAmount: { increment: settlementAmount }, releasedAt: new Date(), status: "RELEASED" },
    });
    if (settled.count !== 1) throw new Error("USAGE_RESERVATION_SETTLEMENT_CONFLICT");
    await tx.usagePeriod.updateMany({
      where: { shop, id: reservation.periodId },
      data: isConsume
        ? { consumedAmount: { increment: settlementAmount } }
        : { releasedAmount: { increment: settlementAmount } },
    });
    return reservation;
  });
}

export function consumeUsage(input) {
  return settleUsage({ ...input, entryType: "CONSUMED" });
}

export function releaseUsage(input) {
  return settleUsage({ ...input, entryType: "RELEASED" });
}
