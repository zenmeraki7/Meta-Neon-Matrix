import { toProductGridDto } from "../dtos/productGridDto.js";
import { fetchProductGridRows } from "../repositories/productGridRepository.js";

async function listProducts(command) {
  const result = await fetchProductGridRows(command.shopId, command.filters);
  return toProductGridDto(result);
}

export const productGridQueryUseCase = Object.freeze({
  listProducts,
});
