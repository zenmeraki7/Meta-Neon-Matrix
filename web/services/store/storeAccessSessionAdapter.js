import shopify from "../../shopify.js";
import { ensureStoreForSession } from "../../repositories/storeRepository.js";

async function readShopTimezone(session) {
  try {
    const client = new shopify.api.clients.Graphql({ session });
    const response = await client.query({
      data: {
        query: `
          query GetShopTimezone {
            shop {
              ianaTimezone
            }
          }
        `,
      },
    });
    return response?.body?.data?.shop?.ianaTimezone || "UTC";
  } catch {
    return "UTC";
  }
}

export function createStoreAccessSessionAdapter(session) {
  return {
    ensureStore: () => ensureStoreForSession(session),
    readShopTimezone: () => readShopTimezone(session),
  };
}

