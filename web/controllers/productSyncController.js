import {
  buildAuthenticatedActor,
  getIdempotencyKey,
  handleControllerError,
  requireShopifySession,
} from "./controllerUtils.js";

import { ProductSyncCommandService } from "../services/productSync/ProductSyncCommandService.js";
import { buildClearProductTypesCommand } from "../normalizers/productSyncCommandNormalizer.js";
import { toProductSyncCommandAcceptedDto } from "../dtos/productSyncDto.js";

const productSyncCommandService = new ProductSyncCommandService();

export const clearProductTypes = async (req, res) => {
  try {
    const session = requireShopifySession(res);

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
    return handleControllerError(res, error, "CLEAR_PRODUCT_TYPES_FAILED");
  }
};
