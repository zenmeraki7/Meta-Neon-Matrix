import {
  buildAuthenticatedActor,
  getRequiredIdempotencyKey,
  handleControllerError,
  requireShopifySession,
} from "./controllerUtils.js";

import {
  ProductSyncCommandService,
} from "../services/productSync/ProductSyncCommandService.js";

import {
  buildClearProductTypesCommand,
} from "../normalizers/productSyncCommandNormalizer.js";

import {
  toProductSyncCommandAcceptedDto,
} from "../dtos/productSyncDto.js";

function assertProductSyncCommandService(service) {
  if (
    !service ||
    typeof service.createClearProductTypesCommand !== "function"
  ) {
    throw new TypeError(
      "A valid productSyncCommandService is required",
    );
  }

  return service;
}

export function createProductSyncController({
  productSyncCommandService,
}) {
  const commandService = assertProductSyncCommandService(
    productSyncCommandService,
  );

  async function clearProductTypes(req, res) {
    try {
      const session = requireShopifySession(req, res);

      const command = buildClearProductTypesCommand({
        shop: session.shop,
        actor: buildAuthenticatedActor(req, session),
        idempotencyKey: getRequiredIdempotencyKey(req),
      });

      const acceptedCommand =
        await commandService.createClearProductTypesCommand(
          command,
        );

      return res
        .status(202)
        .json(
          toProductSyncCommandAcceptedDto(acceptedCommand),
        );
    } catch (error) {
      return handleControllerError(
        req,
        res,
        error,
        "CLEAR_PRODUCT_TYPES_FAILED",
      );
    }
  }

  return Object.freeze({
    clearProductTypes,
  });
}

const productSyncController = createProductSyncController({
  productSyncCommandService:
    new ProductSyncCommandService(),
});

export const {
  clearProductTypes,
} = productSyncController;