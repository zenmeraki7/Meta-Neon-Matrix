import { Services } from "../productService/productFilterService.js";
import { FilterCombinationRepository } from "../../repositories/filterCombinationRepository.js";

function computeTitle(customTitle, filterTitles) {
  const title = String(customTitle || "").trim();
  if (title) return title;
  return String(filterTitles || "Saved filter");
}

function computeDescription(filterDescriptions) {
  const description = String(filterDescriptions || "").trim();
  return description || "Saved filter combination";
}

function normalizeFilters(filters) {
  if (!Array.isArray(filters)) {
    const error = new Error("INVALID_FILTER_PARAMS");
    error.code = "INVALID_FILTER_PARAMS";
    throw error;
  }
  return filters;
}

export class FilterCombinationService {
  constructor() {
    this.repository = new FilterCombinationRepository();
    this.productService = new Services();
  }

  async add({ shop, filterParams, customTitle }) {
    const filters = normalizeFilters(filterParams);
    const titleInput = String(customTitle || "").trim();
    if (!titleInput) {
      const error = new Error("CUSTOM_TITLE_REQUIRED");
      error.code = "CUSTOM_TITLE_REQUIRED";
      throw error;
    }

    const count = await this.repository.countByShop(shop);
    if (count >= 10) {
      const error = new Error("MAX_FILTER_COMBINATIONS_REACHED");
      error.code = "MAX_FILTER_COMBINATIONS_REACHED";
      throw error;
    }

    const metadataBuilder = this.productService.buildProductFilters;
    const metadata = typeof metadataBuilder === "function"
      ? await metadataBuilder.call(this.productService, filters, {
        includeDescriptions: true,
        includeTitles: true,
      })
      : { filterTitles: titleInput, filterDescriptions: "" };
    const { filterTitles, filterDescriptions } = metadata || {};

    return this.repository.create({
      shop,
      filters,
      customTitle: titleInput,
      title: computeTitle(titleInput, filterTitles),
      description: computeDescription(filterDescriptions),
    });
  }

  async list({ shop }) {
    return this.repository.listByShop(shop, 10);
  }

  async update({ shop, id, filters }) {
    const normalizedFilters = normalizeFilters(filters);
    const updated = await this.repository.updateById({
      id,
      shop,
      filters: normalizedFilters,
    });
    if (!updated) {
      const error = new Error("FILTER_COMBINATION_NOT_FOUND");
      error.code = "NOT_FOUND";
      throw error;
    }
    return updated;
  }

  async remove({ shop, id }) {
    const deleted = await this.repository.deleteById({ id, shop });
    if (!deleted) {
      const error = new Error("FILTER_COMBINATION_NOT_FOUND");
      error.code = "NOT_FOUND";
      throw error;
    }
  }
}

export default FilterCombinationService;
