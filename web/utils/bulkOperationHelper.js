import { adminGraphqlWithRetry } from "./shopifyAdminApi.js";

export async function getCurrentBulkOperationStatus(
  session,
  type = "MUTATION",
) {
  const query = `
    query CurrentBulkOperation($type: BulkOperationType!) {
      currentBulkOperation(type: $type) {
        id
        type
        status
        objectCount
        errorCode
        createdAt
        completedAt
      }
    }
  `;

  const response = await adminGraphqlWithRetry({
    session,
    shop: session?.shop,
    commandType: "currentBulkOperation",
    data: {
      query,
      variables: { type },
    },
  });

  return response.body?.data?.currentBulkOperation || { status: "COMPLETED" };
}

export async function getBulkEditStatus(shopifyBulkOperationId, session) {
  if (!shopifyBulkOperationId) {
    throw new Error("Bulk operation ID is required");
  }

  const query = `
    query GetBulkOperationResults($id: ID!) {
      node(id: $id) {
        ... on BulkOperation {
          id
          status
          errorCode
          rootObjectCount
          objectCount
          createdAt
          completedAt
        }
      }
    }
  `;

  const response = await adminGraphqlWithRetry({
    session,
    shop: session?.shop,
    commandType: "bulkOperationStatus",
    data: {
      query,
      variables: { id: shopifyBulkOperationId },
    },
  });

  return response.body?.data?.node || null;
}
