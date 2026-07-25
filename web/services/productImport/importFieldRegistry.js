export const IMPORT_FIELD_REGISTRY = Object.freeze({
  id: Object.freeze({
    ownerType: "PRODUCT",
    valueType: "gid",
    requiredForImport: true,
  }),
  variant_id: Object.freeze({
    ownerType: "VARIANT",
    valueType: "gid",
    requiredForVariantUpdates: true,
  }),
  title: Object.freeze({ ownerType: "PRODUCT", valueType: "string", maxLength: 255 }),
  description: Object.freeze({ ownerType: "PRODUCT", valueType: "html" }),
  vendor: Object.freeze({ ownerType: "PRODUCT", valueType: "string", maxLength: 255 }),
  productType: Object.freeze({ ownerType: "PRODUCT", valueType: "string", maxLength: 255 }),
  handle: Object.freeze({ ownerType: "PRODUCT", valueType: "string", maxLength: 255 }),
  status: Object.freeze({ ownerType: "PRODUCT", valueType: "enum" }),
  tags: Object.freeze({ ownerType: "PRODUCT", valueType: "csv_string" }),
  metaTitle: Object.freeze({ ownerType: "PRODUCT", valueType: "string", maxLength: 70 }),
  metaDescription: Object.freeze({ ownerType: "PRODUCT", valueType: "string", maxLength: 320 }),
  price: Object.freeze({ ownerType: "VARIANT", valueType: "decimal" }),
  compareAtPrice: Object.freeze({ ownerType: "VARIANT", valueType: "decimal" }),
  sku: Object.freeze({ ownerType: "VARIANT", valueType: "string", maxLength: 255 }),
  barcode: Object.freeze({ ownerType: "VARIANT", valueType: "string", maxLength: 255 }),
  taxable: Object.freeze({ ownerType: "VARIANT", valueType: "boolean" }),
  option1Name: Object.freeze({ ownerType: "PRODUCT", valueType: "string", maxLength: 255 }),
  option2Name: Object.freeze({ ownerType: "PRODUCT", valueType: "string", maxLength: 255 }),
  option3Name: Object.freeze({ ownerType: "PRODUCT", valueType: "string", maxLength: 255 }),
  option1Value: Object.freeze({ ownerType: "VARIANT", valueType: "string", maxLength: 255 }),
  option2Value: Object.freeze({ ownerType: "VARIANT", valueType: "string", maxLength: 255 }),
  option3Value: Object.freeze({ ownerType: "VARIANT", valueType: "string", maxLength: 255 }),
});

export const ALLOWED_IMPORT_FIELD_KEYS = new Set([
  "",
  ...Object.keys(IMPORT_FIELD_REGISTRY),
]);

export function isAllowedImportFieldKey(fieldKey) {
  return ALLOWED_IMPORT_FIELD_KEYS.has(String(fieldKey ?? ""));
}
