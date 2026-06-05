function safeText(value, fallback = null, maxLength = 10_000) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return text ? text.slice(0, maxLength) : fallback;
}

function safeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeBoolean(value) {
  return typeof value === "boolean" ? value : Boolean(value);
}

function safeNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function successEnvelope(message, data) {
  return { success: true, message, data };
}

function errorEnvelope(message, data) {
  return { success: false, message, data };
}

export function toProductCodeSnippetDto(snippet) {
  return {
    id: safeText(snippet?.id, null, 200),
    title: safeText(snippet?.title, null, 500),
    status: safeText(snippet?.status, null, 80),
    language: safeText(snippet?.language, null, 80),
    code: safeText(snippet?.code, null, 50_000),
    normalizedAst: safeObject(snippet?.normalizedAst),
    lastValidationStatus: safeText(snippet?.lastValidationStatus, null, 80),
    lastValidationError: safeText(snippet?.lastValidationError, null, 2_000),
    lastPreviewedAt: safeDate(snippet?.lastPreviewedAt),
    createdBy: safeText(snippet?.createdBy, null, 255),
    updatedBy: safeText(snippet?.updatedBy, null, 255),
    createdAt: safeDate(snippet?.createdAt),
    updatedAt: safeDate(snippet?.updatedAt),
  };
}

export function toSnippetCreatedDto(result) {
  return successEnvelope("Snippet created successfully", toProductCodeSnippetDto(result));
}

export function toSnippetListDto(result) {
  return successEnvelope(
    "Snippets fetched successfully",
    Array.isArray(result) ? result.map(toProductCodeSnippetDto) : [],
  );
}

export function toSnippetDetailDto(result) {
  return successEnvelope("Snippet fetched successfully", toProductCodeSnippetDto(result));
}

export function toSnippetUpdatedDto(result) {
  return successEnvelope("Snippet updated successfully", toProductCodeSnippetDto(result));
}

export function toSnippetArchivedDto(result) {
  return successEnvelope("Snippet archived successfully", toProductCodeSnippetDto(result));
}

export function toSnippetValidationResponseDto(result) {
  const data = {
    snippet: toProductCodeSnippetDto(result?.snippet),
    validationStatus: safeText(result?.validationStatus, "INVALID", 80),
    normalizedAst: safeObject(result?.normalizedAst),
    error: safeText(result?.error, null, 2_000),
  };

  if (data.validationStatus === "VALID") {
    return {
      statusCode: 200,
      body: successEnvelope("Snippet validation completed", data),
    };
  }

  return {
    statusCode: 422,
    body: errorEnvelope("Snippet validation failed", data),
  };
}

export function toSnippetPreviewDto(result) {
  return successEnvelope("Snippet preview completed", {
    product: result?.product
      ? {
          id: safeText(result.product.id, null, 200),
          title: safeText(result.product.title, null, 500),
          handle: safeText(result.product.handle, null, 500),
          status: safeText(result.product.status, null, 80),
          vendor: safeText(result.product.vendor, null, 500),
          productType: safeText(result.product.productType, null, 500),
          featuredImageUrl: safeText(result.product.featuredImageUrl, null, 2_000),
          variantCount: safeNumber(result.product.variantCount, 0),
        }
      : null,
    matched: safeBoolean(result?.matched),
    branchUsed: safeText(result?.branchUsed, null, 200),
    normalizedOutput: safeObject(result?.normalizedOutput) || {},
    rulePreview: safeObject(result?.rulePreview) || {},
    hasOutput: safeBoolean(result?.hasOutput),
  });
}

export function toSnippetPreviewProductsDto(result) {
  return successEnvelope(
    "Products fetched successfully",
    Array.isArray(result)
      ? result.map((product) => ({
          id: safeText(product?.id, null, 200),
          title: safeText(product?.title, null, 500),
          handle: safeText(product?.handle, null, 500),
          status: safeText(product?.status, null, 80),
          vendor: safeText(product?.vendor, null, 500),
          featuredImageUrl: safeText(product?.featuredImageUrl, null, 2_000),
          variantCount: safeNumber(product?.variantCount, 0),
        }))
      : [],
  );
}
