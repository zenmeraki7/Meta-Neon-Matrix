import SubscriptionCommandService from "../services/subscription/SubscriptionCommandService.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import { getPlanSnapshot } from "../services/subscription/SubscriptionQueryService.js";
import { normalizeSubscriptionPlanQuery } from "../normalizers/subscriptionPlanQueryNormalizer.js";
import { toSubscriptionPlanSnapshotDto } from "../dtos/subscriptionPlanDto.js";

const subscriptionCommandService = new SubscriptionCommandService();

export const getPlansController = async (req, res) => {
  try {
    const command = normalizeSubscriptionPlanQuery(res.locals, req.query || {});
    const snapshot = await getPlanSnapshot(command);

    return res.status(200).json(toSubscriptionPlanSnapshotDto(snapshot));
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const createSubscriptionController = async (req, res) => {
  try {
    const session = res.locals.shopify?.session;

    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const result = await subscriptionCommandService.createSubscriptionCommand({
      shop: session.shop,
      command: {
        planKey: req.body?.planKey,
        returnUrl: req.body?.returnUrl || null,
      },
      idempotencyKey: req.headers["idempotency-key"],
    });

    return res.status(202).json({
      success: true,
      subscriptionCommandId: result.commandId,
      status: result.status,
      confirmationUrl: result.confirmationUrl ?? null,
    });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};
