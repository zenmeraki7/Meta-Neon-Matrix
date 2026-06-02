import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import {
  getSyncStatusDetailForShop,
  getSyncStatusSummaryForShop,
  getTrackedProductSyncStatus,
} from "../services/syncStatusQueryService.js";
import { startProductSync } from "../services/sync/SyncCommandService.js";
import { normalizeSyncStartCommand } from "../normalizers/syncStartCommandNormalizer.js";
import { toSyncCommandResponseDto } from "../dtos/syncCommandResponseDto.js";

export const syncProductData = async (req, res) => {
  const session = res.locals?.shopify?.session;

  try {
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

        console.log(`[api:sync_request] shop=${session.shop} force=${req.query.force || req.body?.force}`);

    const command = normalizeSyncStartCommand(req, session);
    const result = await startProductSync(command);
    const responseDto = toSyncCommandResponseDto(result);
    console.log(`[api:sync_triggered] shop=${session.shop} bulkOperationId=${result.bulkOperationId} syncHistoryId=${result.syncHistoryId}`);

    return res.status(200).json(responseDto);
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "syncController.syncProductData",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const getSyncStatus = async (req, res) => {
  const session = res.locals?.shopify?.session;

  try {
    const shop = session?.shop;

    if (!shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const response = await getSyncStatusDetailForShop(shop);
    return res.status(200).json(response);
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "syncController.getSyncStatus",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const getSyncStatusDetail = getSyncStatus;

export const getSyncStatusSummary = async (req, res) => {
  const session = res.locals?.shopify?.session;

  try {
    const shop = session?.shop;
    if (!shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const response = await getSyncStatusSummaryForShop(shop);
    return res.status(200).json(response);
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "syncController.getSyncStatusSummary",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const trackProductSync = async (req, res) => {
  let session = null;
  try {
    session = res.locals?.shopify?.session || null;
    const shop = session?.shop;

    if (!shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const response = await getTrackedProductSyncStatus({ session, shop });
    return res.status(200).json(response);
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "syncController.trackProductSync",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};
