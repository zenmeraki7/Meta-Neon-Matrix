export const GetLocations = `
  query GetLocations($first: Int = 250, $after: String, $search: String) {
    locations(first: $first, after: $after, query: $search) {
      edges {
        cursor
        node {
          id
          name
          isActive
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
