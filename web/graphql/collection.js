const COLLECTION_CORE_FRAGMENT = `#graphql
  fragment CollectionCore on Collection {
    id
    title
    handle
  }
`;

export const StartCollectionBulkSyncMutation = `#graphql
mutation StartCollectionBulkSyncMutation {
  bulkOperationRunQuery(
    query: """
      ${COLLECTION_CORE_FRAGMENT}
      {
        collections {
          edges {
            node {
              ...CollectionCore
            }
          }
        }
      }
    """
  ) {
    bulkOperation {
      id
      status
      objectCount
      fileSize
    }
    userErrors {
      field
      message
    }
  }
}`;

export const GetCollections = `#graphql
  ${COLLECTION_CORE_FRAGMENT}
  query GetCollections($first: Int!, $after: String, $query: String) {
    collections(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          ...CollectionCore
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
