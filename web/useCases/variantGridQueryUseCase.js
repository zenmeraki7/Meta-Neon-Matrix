import { toVariantGridDto } from "../dtos/variantGridDto.js";
import { fetchVariantGridRows } from "../repositories/variantGridRepository.js";

async function listVariants(command) {
  const raw = await fetchVariantGridRows(command.shop, command.query);
  return toVariantGridDto(raw);
}

export const variantGridQueryUseCase = Object.freeze({
  listVariants,
});
