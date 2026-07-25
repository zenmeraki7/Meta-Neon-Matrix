import { graphqlProductsBulkSyncQuery } from "../../graphql/product.js";
import { adminGraphqlWithRetry } from "../../utils/shopifyAdminApi.js";

function buildCodedError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details !== null) error.details = details;
  return error;
}

export async function runProductBulkFetch({ session }) {
  const shop = String(session?.shop || "").trim();
  const queryBody = String(graphqlProductsBulkSyncQuery || "").trim();

  if (!shop) {
    throw buildCodedError("SHOP_REQUIRED", "Shopify session shop is required");
  }
  if (!session?.accessToken) {
    throw buildCodedError(
      "ACCESS_TOKEN_REQUIRED",
      "Shopify access token is required",
    );
  }
  if (!queryBody) {
    throw buildCodedError(
      "PRODUCT_BULK_QUERY_EMPTY",
      "graphqlProductsBulkSyncQuery is empty",
    );
  }

  const mutation = `
    mutation RunProductBulkFetch($query: String!, $groupObjects: Boolean!) {
      bulkOperationRunQuery(query: $query, groupObjects: $groupObjects) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await adminGraphqlWithRetry({
    session,
    shop,
    commandType: "RunProductBulkFetch",
    data: {
      query: mutation,
      variables: { query: queryBody, groupObjects: true },
    },
  });

  const responseBody = response?.body ?? null;
  const topLevelErrors = Array.isArray(responseBody?.errors)
    ? responseBody.errors
    : [];

  if (topLevelErrors.length > 0) {
    throw buildCodedError(
      "SHOPIFY_GRAPHQL_ERROR",
      topLevelErrors.map((item) => item?.message).filter(Boolean).join("; ") ||
        "Shopify GraphQL request failed",
      topLevelErrors,
    );
  }

  const result = responseBody?.data?.bulkOperationRunQuery;
  const userErrors = Array.isArray(result?.userErrors)
    ? result.userErrors
    : [];

  if (userErrors.length > 0) {
    throw buildCodedError(
      "SHOPIFY_USER_ERROR",
      userErrors
        .map((item) => {
          const field = Array.isArray(item?.field)
            ? item.field.join(".")
            : item?.field;
          return field ? `${field}: ${item.message}` : item.message;
        })
        .join("; "),
      userErrors,
    );
  }

  const bulkOperation = result?.bulkOperation;
  if (!bulkOperation?.id) {
    throw buildCodedError(
      "BULK_OPERATION_ID_MISSING",
      "Shopify did not return a bulk operation ID",
      responseBody,
    );
  }

  return {
    shopifyBulkOperationId: String(bulkOperation.id),
    status: bulkOperation.status || null,
    responseBody,
  };
}
