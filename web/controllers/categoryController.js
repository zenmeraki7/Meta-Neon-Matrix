// web/controllers/categoryController.js
import {
  toCategoryListResponseDto,
  toCategoryOptionResponseDto,
} from "../dtos/categoryDto.js";
import { requireShopifySession } from "../http/shopifySession.js";
import { buildActorFromSession } from "../http/actorContext.js";
import { validateCategoryQuery } from "../validators/categoryRequestValidator.js";

export const getAllCategories =
  (categoryService) => async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");

      const session = requireShopifySession(res, "Authentication required");
      const query = validateCategoryQuery(req.query);

      const command = Object.freeze({
        shop: session.shop,
        search: query.search,
        limit: query.limit,
        cursor: query.cursor,
        actor: buildActorFromSession(session),
      });

      const result = await categoryService.getAllCategories(command);

      return res.status(200).json(
        toCategoryListResponseDto(result, { search: query.search }),
      );
    } catch (error) {
      return next(error);
    }
  };

export const getCategoryOptions =
  (categoryService) => async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");

      const session = requireShopifySession(res, "Authentication required");
      const query = validateCategoryQuery(req.query);

      const command = Object.freeze({
        shop: session.shop,
        search: query.search,
        limit: query.limit,
        cursor: query.cursor,
        actor: buildActorFromSession(session),
      });

      const result = await categoryService.getAllCategories(command);

      return res.status(200).json(
        toCategoryOptionResponseDto(result, { search: query.search }),
      );
    } catch (error) {
      return next(error);
    }
  };
