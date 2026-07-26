// web/utils/sessionHandler.js
import shopify from "../shopify.js";

import { db } from "../repositories/repositoryDb.js";
import { decryptAccessToken } from "./tokenCrypto.js";

export const getSession = async (shop) => {
  try {
    const store = await db.store.findUnique({
      where: { shopUrl: shop },
      select: {
        shopUrl: true,
        accessTokenEncrypted: true,
        accessTokenKeyVersion: true,
      },
    });

    let resolvedToken = null;
    if (store?.accessTokenEncrypted) {
      try {
        resolvedToken = decryptAccessToken(store.accessTokenEncrypted);
      } catch {
        resolvedToken = null;
      }
    }

    if (!resolvedToken) {
      throw new Error(`Encrypted token required but missing for shop: ${shop}`);
    }

    // Shape compatible with how you use `session` elsewhere
    return {
      shop: store.shopUrl,
      accessToken: resolvedToken,
    };
  } catch (error) {
    // Optional: log error for debugging
    console.error("[getSession] Failed to retrieve session for shop:", shop, error);
    throw new Error("Failed to retrieve session");
  }
};

export const getShopOwnerEmailAddress = async (session) => {
  try {
    const client = new shopify.api.clients.Graphql({ session });

    const response = await client.query({
      data: {
        query: `
          {
            shop {
              email
              shopOwnerName
            }
          }
        `,
      },
    });

    const shopData = response.body.data.shop;
    return {
      email: shopData.email,
      shopOwner: shopData.shopOwnerName,
    };
  } catch (error) {
    throw new Error(
      error.message || "Failed to retrieve shop owner email address"
    );
  }
};
