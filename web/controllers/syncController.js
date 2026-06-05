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
import {
  toSyncStatusDetailDto,
  toSyncStatusSummaryDto,
  toTrackedSyncStatusDto,
} from "../dtos/syncStatusResponseDto.js";

export const syncProductData = async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const command = normalizeSyncStartCommand(req, session);
    console.log(`[api:sync_request] shop=${session.shop} force=${command.force}`);

    const result = await startProductSync(command);
    const responseDto = toSyncCommandResponseDto(result);
    console.log(`[api:sync_triggered] shop=${session.shop} syncHistoryId=${responseDto.syncHistoryId}`);

    return res.status(200).json(responseDto);
  } catch (error) {
    await logApiError({
      shop: res.locals?.shopify?.session?.shop,
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
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;

    const result = await getSyncStatusDetailForShop(shop);
    return res.status(200).json(toSyncStatusDetailDto(result));
  } catch (error) {
    await logApiError({
      shop: res.locals?.shopify?.session?.shop,
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

export const getSyncStatusSummary = async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;

    const result = await getSyncStatusSummaryForShop(shop);
    return res.status(200).json(toSyncStatusSummaryDto(result));
  } catch (error) {
    await logApiError({
      shop: res.locals?.shopify?.session?.shop,
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
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;
    const { bulkOperationStatusReader } = res.locals.syncStatusDependencies;

    const result = await getTrackedProductSyncStatus({
      shop,
      bulkOperationStatusReader,
    });
    return res.status(200).json(toTrackedSyncStatusDto(result));
  } catch (error) {
    await logApiError({
      shop: res.locals?.shopify?.session?.shop,
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
