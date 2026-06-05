import { toVariantGridDto } from "../../dtos/variantGridDto.js";

async function defaultFetchRows(shop, query) {
  const { fetchVariantGridRows } = await import("../../repositories/variantGridRepository.js");
  return fetchVariantGridRows(shop, query);
}

export class VariantGridQueryService {
  constructor({ fetchRows = defaultFetchRows } = {}) {
    this.fetchRows = fetchRows;
  }

  async getVariantGrid(command = {}) {
    const result = await this.fetchRows(command.shop, command.query || {});
    return toVariantGridDto(result);
  }
}

const defaultService = new VariantGridQueryService();

export async function getVariantGrid(command = {}) {
  return defaultService.getVariantGrid(command);
}
