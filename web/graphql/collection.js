export const StartCollectionBulkQuery = `mutation {
  bulkOperationRunQuery(
    query: """
      {
        collections {
          edges {
            node {
              id
              title
              handle
            }
          }
        }
      }
    """
  ) {
    bulkOperation {
      id
      status
    }
    userErrors {
      field
      message
    }
  }
}`;

export const GetCollections = `#graphql
  query GetCollections($first: Int!, $query: String) {
    collections(first: $first, query: $query) {
      edges {
        node {
          id
          title
          handle
        }
      }
    }
  }
`;
