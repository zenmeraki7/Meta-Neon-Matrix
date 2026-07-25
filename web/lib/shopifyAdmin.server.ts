import shopify from "../shopify.js";
import { prisma } from "../config/database.js";

export async function getAdminGraphqlForShop(shop: string) {
  const session = await prisma.session.findFirst({
    where: {
      shop,
      isOnline: false,
    },
  });

  if (!session?.accessToken) {
    throw new Error("SHOP_OFFLINE_SESSION_NOT_FOUND");
  }

  const client = new shopify.api.clients.Graphql({
    session,
  });

  return async function adminGraphql(
    query: string,
    options?: { variables?: Record<string, unknown> }
  ) {
    const result = await client.query({
      data: {
        query,
        variables: options?.variables ?? {},
      },
    });

    return {
      async json() {
        return result.body;
      },
    };
  };
}
