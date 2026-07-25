const GRANULARITY = Object.freeze({
  PRODUCT: "PRODUCT",
  VARIANT: "VARIANT",
  BOTH: "BOTH",
});

function decimalToString(value) {
  if (value === null || value === undefined) return "";
  return typeof value?.toString === "function" ? value.toString() : String(value);
}

function dateToIso(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function joinTextArray(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(", ") : "";
}

function collectionTitles(value) {
  if (!Array.isArray(value)) return "";
  return value.map((collection) => collection?.title).filter(Boolean).join(", ");
}

const PRODUCT_EXPORT_FIELDS = [
  {
    key: "id",
    label: "Product ID",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.id",
    resolve: ({ product }) => product?.id ?? "",
  },
  {
    key: "productGid",
    label: "Product GID",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.id",
    resolve: ({ product }) => product?.id ?? "",
  },
  {
    key: "title",
    label: "Title",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.title",
    resolve: ({ product }) => product?.title ?? "",
  },
  {
    key: "handle",
    label: "Handle",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.handle",
    resolve: ({ product }) => product?.handle ?? "",
  },
  {
    key: "status",
    label: "Status",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.status",
    resolve: ({ product }) => product?.status ?? "",
  },
  {
    key: "vendor",
    label: "Vendor",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.vendor",
    resolve: ({ product }) => product?.vendor ?? "",
  },
  {
    key: "productType",
    label: "Product Type",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.productType",
    resolve: ({ product }) => product?.productType ?? "",
  },
  {
    key: "tags",
    label: "Tags",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.tags",
    resolve: ({ product }) => joinTextArray(product?.tags),
  },
  {
    key: "descriptionHtml",
    aliases: ["description"],
    label: "Description HTML",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.descriptionHtml",
    resolve: ({ product }) => product?.descriptionHtml ?? "",
  },
  {
    key: "seoTitle",
    aliases: ["metaTitle"],
    label: "SEO Title",
    granularity: GRANULARITY.PRODUCT,
    group: "seo",
    sourcePath: "Product.seoTitle",
    resolve: ({ product }) => product?.seoTitle ?? "",
  },
  {
    key: "seoDescription",
    aliases: ["metaDescription"],
    label: "SEO Description",
    granularity: GRANULARITY.PRODUCT,
    group: "seo",
    sourcePath: "Product.seoDescription",
    resolve: ({ product }) => product?.seoDescription ?? "",
  },
  {
    key: "createdAtShopify",
    label: "Created At",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.createdAt",
    resolve: ({ product }) => dateToIso(product?.createdAt),
  },
  {
    key: "updatedAtShopify",
    label: "Updated At",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.updatedAt",
    resolve: ({ product }) => dateToIso(product?.updatedAt),
  },
  {
    key: "publishedAt",
    label: "Published At",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.publishedAt",
    resolve: ({ product }) => dateToIso(product?.publishedAt),
  },
  {
    key: "totalInventory",
    label: "Total Inventory",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.totalInventory",
    resolve: ({ product }) => product?.totalInventory ?? "",
  },
  {
    key: "variantCount",
    label: "Variant Count",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.variantCount",
    resolve: ({ product }) => product?.variantCount ?? "",
  },
  {
    key: "collections",
    label: "Collections",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.collectionsJson",
    resolve: ({ product }) => collectionTitles(product?.collectionsJson),
  },
  {
    key: "category",
    label: "Category",
    granularity: GRANULARITY.PRODUCT,
    group: "product",
    sourcePath: "Product.categoryName",
    resolve: ({ product }) => product?.categoryName ?? "",
  },
  {
    key: "option1Name",
    label: "Option 1 Name",
    granularity: GRANULARITY.PRODUCT,
    group: "variant",
    sourcePath: "Product.option1Name",
    resolve: ({ product }) => product?.option1Name ?? "",
  },
  {
    key: "option2Name",
    label: "Option 2 Name",
    granularity: GRANULARITY.PRODUCT,
    group: "variant",
    sourcePath: "Product.option2Name",
    resolve: ({ product }) => product?.option2Name ?? "",
  },
  {
    key: "option3Name",
    label: "Option 3 Name",
    granularity: GRANULARITY.PRODUCT,
    group: "variant",
    sourcePath: "Product.option3Name",
    resolve: ({ product }) => product?.option3Name ?? "",
  },
  {
    key: "variantId",
    label: "Variant ID",
    granularity: GRANULARITY.VARIANT,
    group: "variant",
    sourcePath: "Variant.id",
    resolve: ({ variant }) => variant?.id ?? "",
  },
  {
    key: "variantGid",
    label: "Variant GID",
    granularity: GRANULARITY.VARIANT,
    group: "variant",
    sourcePath: "Variant.id",
    resolve: ({ variant }) => variant?.id ?? "",
  },
  {
    key: "variantTitle",
    label: "Variant Title",
    granularity: GRANULARITY.VARIANT,
    group: "variant",
    sourcePath: "Variant.title",
    resolve: ({ variant }) => variant?.title ?? "",
  },
  {
    key: "sku",
    label: "SKU",
    granularity: GRANULARITY.VARIANT,
    group: "variant",
    sourcePath: "Variant.sku",
    resolve: ({ variant }) => variant?.sku ?? "",
  },
  {
    key: "barcode",
    label: "Barcode",
    granularity: GRANULARITY.VARIANT,
    group: "variant",
    sourcePath: "Variant.barcode",
    resolve: ({ variant }) => variant?.barcode ?? "",
  },
  {
    key: "price",
    label: "Price",
    granularity: GRANULARITY.VARIANT,
    group: "variant",
    sourcePath: "Variant.price",
    resolve: ({ variant }) => decimalToString(variant?.price),
  },
  {
    key: "compareAtPrice",
    label: "Compare At Price",
    granularity: GRANULARITY.VARIANT,
    group: "variant",
    sourcePath: "Variant.compareAtPrice",
    resolve: ({ variant }) => decimalToString(variant?.compareAtPrice),
  },
  {
    key: "cost",
    label: "Cost",
    granularity: GRANULARITY.VARIANT,
    group: "variant",
    sourcePath: "Variant.cost",
    resolve: ({ variant }) => decimalToString(variant?.cost),
  },
  {
    key: "inventoryQuantity",
    label: "Inventory Quantity",
    granularity: GRANULARITY.VARIANT,
    group: "variant",
    sourcePath: "Variant.inventoryQuantity",
    resolve: ({ variant }) => variant?.inventoryQuantity ?? "",
  },
  {
    key: "taxable",
    label: "Taxable",
    granularity: GRANULARITY.VARIANT,
    group: "variant",
    sourcePath: "Variant.taxable",
    resolve: ({ variant }) =>
      typeof variant?.taxable === "boolean" ? variant.taxable : "",
  },
];

const REGISTRY = Object.freeze(
  PRODUCT_EXPORT_FIELDS.map((field) =>
    Object.freeze({
      exportable: true,
      sortable: false,
      filterable: false,
      nullValue: "",
      ...field,
      aliases: Object.freeze(field.aliases || []),
    }),
  ),
);

const FIELD_BY_KEY = new Map();
for (const field of REGISTRY) {
  FIELD_BY_KEY.set(field.key, field);
  for (const alias of field.aliases) {
    FIELD_BY_KEY.set(alias, field);
  }
}

function validationError(message, details = {}) {
  const error = new Error(message);
  error.code = "VALIDATION_FAILED";
  Object.assign(error, details);
  return error;
}

function normalizeGranularity(value = GRANULARITY.PRODUCT) {
  const normalized = String(value || GRANULARITY.PRODUCT).trim().toUpperCase();
  return normalized === GRANULARITY.VARIANT ? GRANULARITY.VARIANT : GRANULARITY.PRODUCT;
}

function isFieldAllowedForGranularity(field, targetGranularity) {
  if (field.granularity === GRANULARITY.BOTH) return true;
  if (targetGranularity === GRANULARITY.PRODUCT) {
    return field.granularity === GRANULARITY.PRODUCT;
  }
  return true;
}

export function listExportFields({ targetGranularity = GRANULARITY.PRODUCT } = {}) {
  const granularity = normalizeGranularity(targetGranularity);
  return REGISTRY.filter((field) => isFieldAllowedForGranularity(field, granularity)).map(
    (field) => ({
      key: field.key,
      label: field.label,
      value: field.key,
      group: field.group,
      granularity: field.granularity,
      exportable: field.exportable,
      sortable: field.sortable,
      filterable: field.filterable,
      sourcePath: field.sourcePath,
    }),
  );
}

export function getAllowedExportFieldKeys(options = {}) {
  return listExportFields(options).map((field) => field.key);
}

export function assertSupportedExportFields(fields = [], options = {}) {
  const granularity = normalizeGranularity(options.targetGranularity);

  if (!Array.isArray(fields) || fields.length === 0) {
    throw validationError("FIELDS_REQUIRED", {
      errors: { fields: [] },
      allowedFields: getAllowedExportFieldKeys({ targetGranularity: granularity }),
    });
  }

  const seen = new Set();
  const definitions = [];
  const allowedFields = getAllowedExportFieldKeys({ targetGranularity: granularity });

  for (const rawField of fields) {
    const key = String(rawField || "").trim();
    const field = FIELD_BY_KEY.get(key);

    if (!field || !field.exportable) {
      throw validationError(`Unsupported export field: ${key}`, {
        errors: { fields: [key] },
        unsupportedFields: [key],
        allowedFields,
      });
    }

    if (seen.has(field.key)) {
      throw validationError(`Duplicate export field: ${key}`, {
        errors: { fields: [key] },
        duplicateFields: [key],
        allowedFields,
      });
    }

    if (!isFieldAllowedForGranularity(field, granularity)) {
      throw validationError(
        `Unsupported export field for ${granularity} export: ${key}`,
        {
          errors: { fields: [key] },
          unsupportedFields: [key],
          allowedFields,
        },
      );
    }

    seen.add(field.key);
    definitions.push(field);
  }

  return Object.freeze(definitions);
}

export function sanitizeCsvCell(value) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? joinTextArray(value) : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function buildExportCsvHeaders(fieldDefinitions = []) {
  return fieldDefinitions.map((field) => field.label);
}

export function buildExportCsvRow({ fieldDefinitions = [], product, variant = null }) {
  const row = {};
  for (const field of fieldDefinitions) {
    row[field.label] = sanitizeCsvCell(field.resolve({ product, variant }));
  }
  return row;
}

export const productExportFieldRegistry = REGISTRY;
export const EXPORT_FIELD_GRANULARITY = GRANULARITY;
