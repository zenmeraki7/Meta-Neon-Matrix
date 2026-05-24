import shopify from "../../shopify.js";

const GET_COLLECTIONS_QUERY = `#graphql
  query GetCollections($first: Int!, $query: String) {
    collections(first: $first, query: $query) {
      edges {
        node {
          id
          title
        }
      }
    }
  }
`;

export class CollectionControllerService {
  async fetchFromShopify({ session, search = "", limit = 20 }) {
    const searchText = String(search || "").trim();
    const first = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const queryString = searchText ? `title:${searchText}*` : null;

    const client = new shopify.api.clients.Graphql({ session });
    const response = await client.query({
      data: {
        query: GET_COLLECTIONS_QUERY,
        variables: {
          first,
          query: queryString,
        },
      },
    });

    const edges = response?.body?.data?.collections?.edges || [];
    return edges.map((edge) => ({
      id: edge.node.id,
      title: edge.node.title,
    }));
  }
}

export default CollectionControllerService;
