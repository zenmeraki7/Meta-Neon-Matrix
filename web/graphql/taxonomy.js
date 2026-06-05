export const GetTaxonomyCategories = `#graphql
  query GetTaxonomyCategories($first: Int!, $after: String) {
    taxonomy {
      categories(first: $first, after: $after) {
        edges {
          cursor
          node {
            id
            name
            fullName
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;
