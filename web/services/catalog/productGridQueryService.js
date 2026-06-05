import { toProductGridDto } from "../../dtos/productGridDto.js";
import { fetchProductGridRows } from "../../repositories/productGridRepository.js";

export async function getProductGrid(command = {}) {
  const shop = command.shop || command.shopId;
  const filters = command.filters || {};
  const result = await fetchProductGridRows(shop, filters);
  return toProductGridDto(result);
}
