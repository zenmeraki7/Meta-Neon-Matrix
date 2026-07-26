import {
  handleControllerError,
  requireShopifySession,
} from "./controllerUtils.js";
import {
  getSyncStatusDetailForShop,
  getSyncStatusSummaryForShop,
  getTrackedProductSyncStatus,
} from "../services/syncStatusQueryService.js";
import { startProductSync } from "../services/sync/SyncCommandService.js";
import { normalizeSyncStartCommand } from "../normalizers/syncStartCommandNormalizer.js";
import { toSyncCommandResponseDto } from "../dtos/syncCommandResponseDto.js";
import { setPrivateNoStore } from "../http/cacheHeaders.js";

export const syncProductData = async (req, res) => {
  try {
    const { session, shop } = requireShopifySession(req, res);

    const command = normalizeSyncStartCommand(req, session);
    const result = await startProductSync(command);
    const responseDto = toSyncCommandResponseDto(result);

    return res.status(200).json(responseDto);
  } catch (error) {
    return handleControllerError(
      req,
      res,
      error,
      "SYNC_PRODUCT_DATA_FAILED",
      "syncController.syncProductData",
    );
  }
};

export const getSyncStatus = async (req, res) => {
  try {
    const { shop } = requireShopifySession(req, res);

    setPrivateNoStore(res);
    const response = await getSyncStatusDetailForShop(shop);
    return res.status(200).json(response);
  } catch (error) {
    return handleControllerError(
      req,
      res,
      error,
      "GET_SYNC_STATUS_FAILED",
      "syncController.getSyncStatus",
    );
  }
};

export const getSyncStatusDetail = getSyncStatus;

export const getSyncStatusSummary = async (req, res) => {
  try {
    const { shop } = requireShopifySession(req, res);

    setPrivateNoStore(res);
    const response = await getSyncStatusSummaryForShop(shop);
    return res.status(200).json(response);
  } catch (error) {
    return handleControllerError(
      req,
      res,
      error,
      "GET_SYNC_STATUS_SUMMARY_FAILED",
      "syncController.getSyncStatusSummary",
    );
  }
};

export const trackProductSync = async (req, res) => {
  try {
    const { session, shop } = requireShopifySession(req, res);

    setPrivateNoStore(res);
    const response = await getTrackedProductSyncStatus({ session, shop });
    return res.status(200).json(response);
  } catch (error) {
    return handleControllerError(
      req,
      res,
      error,
      "TRACK_PRODUCT_SYNC_FAILED",
      "syncController.trackProductSync",
    );
  }
};
