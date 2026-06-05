function safeText(value, fallback = null, maxLength = 2_000) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return text ? text.slice(0, maxLength) : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function toMetafieldDefinitionDto(definition) {
  return {
    id: safeText(definition?.id, null, 200),
    shopifyDefinitionId: safeText(
      definition?.shopify_definition_id,
      null,
      200,
    ),
    namespace: safeText(definition?.namespace, null, 255),
    key: safeText(definition?.key, null, 255),
    name: safeText(definition?.name, null, 500),
    description: safeText(definition?.description, null, 2_000),
    type: safeText(definition?.type, null, 255),
    validations: safeArray(definition?.validations),
    visibleToStorefront: Boolean(definition?.visible_to_storefront),
  };
}

export function toMetafieldDefinitionListDto(definitions) {
  return {
    definitions: Array.isArray(definitions)
      ? definitions.map(toMetafieldDefinitionDto)
      : [],
  };
}
