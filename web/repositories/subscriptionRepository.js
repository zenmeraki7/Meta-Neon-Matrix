import { prisma } from "../config/database.js";
import { requireShopScope } from "../utils/shopScope.js";

export async function findActiveSubscription(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.subscription.findFirst({
    where: { shop: resolvedShop, status: "ACTIVE" },
  });
}

export async function getSubscriptionByShop(shop) {
  return findActiveSubscription(shop);
}

export async function findLatestSubscriptionByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.subscription.findFirst({
    where: { shop: resolvedShop },
    orderBy: { createdAt: "desc" },
  });
}
