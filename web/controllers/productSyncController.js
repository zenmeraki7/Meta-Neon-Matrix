import {
  buildAuthenticatedActor,
  getIdempotencyKey,
  handleLoggedControllerError,
  requireShopifySession,
} from "./controllerUtils.js";
import { buildPublicApiErrorResponse as _buildPublicApiErrorResponse } from "../utils/publicApiError.js";

import { buildClearProductTypesCommand } from "../normalizers/productSyncCommandNormalizer.js";
import { toProductSyncCommandAcceptedDto } from "../dtos/productSyncDto.js";

void _buildPublicApiErrorResponse;

export const createClearProductTypesController = (productSyncCommandService) => async (req, res) => {
  let session;

  try {
    session = requireShopifySession(res);

    const command = buildClearProductTypesCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      idempotencyKey: getIdempotencyKey(req),
      subscription: req.subscription || null,
    });

    const result =
      await productSyncCommandService.createClearProductTypesCommand(command);

    return res.status(202).json(toProductSyncCommandAcceptedDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productSyncController.clearProductTypes",
      fallbackCode: "CLEAR_PRODUCT_TYPES_FAILED",
    });
  }
};
