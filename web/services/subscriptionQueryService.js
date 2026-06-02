import { getPlanSnapshot } from "./subscription/SubscriptionQueryService.js";

export async function getSubscriptionPlanSnapshot(shop) {
  return getPlanSnapshot({ shop });
}
