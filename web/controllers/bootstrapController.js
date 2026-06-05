import {
  buildAuthenticatedActor,
  handleLoggedControllerError,
  requireShopifySession,
} from "./controllerUtils.js";
import {
  getDashboardBootstrapData,
  getProductsBootstrapData,
} from "../useCases/bootstrapUseCases.js";
import {
  normalizeDashboardBootstrapQuery,
  normalizeProductsBootstrapQuery,
} from "../normalizers/bootstrapQueryNormalizer.js";
import { toBootstrapSummaryDto } from "../dtos/bootstrapDto.js";

export async function getProductsBootstrap(req, res) {
  let session = null;
  try {
    session = requireShopifySession(res);
    const actor = buildAuthenticatedActor(req, session);
    const query = normalizeProductsBootstrapQuery(req, session);
    const { limit } = query;
    const result = await getProductsBootstrapData({
      shop: session.shop,
      actor,
      limit,
      locals: res.locals,
    });

    return res.status(200).json(toBootstrapSummaryDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "bootstrapController.getProductsBootstrap",
      fallbackCode: "BOOTSTRAP_PRODUCTS_FAILED",
    });
  }
}

export async function getDashboardBootstrap(req, res) {
  let session = null;
  try {
    session = requireShopifySession(res);
    const query = normalizeDashboardBootstrapQuery(session);
    const { shop } = query;
    const result = await getDashboardBootstrapData({
      shop,
      locals: res.locals,
    });

    return res.status(200).json(toBootstrapSummaryDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "bootstrapController.getDashboardBootstrap",
      fallbackCode: "BOOTSTRAP_DASHBOARD_FAILED",
    });
  }
}
