import { productExportFieldRegistry } from "../services/productService/productExportFieldRegistry.js";

// Compatibility facade for older scheduled-export code. New code should import
// the backend-owned productExportFieldRegistry directly.
export const fieldMappings = Object.fromEntries(
  productExportFieldRegistry.flatMap((field) => [
    [field.key, field.sourcePath],
    ...(field.aliases || []).map((alias) => [alias, field.sourcePath]),
  ]),
);
