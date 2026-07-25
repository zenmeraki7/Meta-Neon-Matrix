// web/utils/sessionHandler.js
import shopify from "../shopify.js";

import { db } from "../repositories/repositoryDb.js";
import {
  buildEncryptedTokenColumns,
  decryptAccessToken,
} from "./tokenCrypto.js";


// Legacy reference (kept as a comment for context)
// export const getSession = async (shop) => {
//   try {
//     const sessions = await shopify.config.sessionStorage.findSessionsByShop(shop);
//     if (!sessions || sessions.length === 0) {
//       throw new Error(`No active session found for shop: ${shop}`);
//     }
//     return sessions[0];
//   } catch (error) {
//     throw new Error("Failed to retrieve session");
//   }
// };

export const getSession = async (shop) => {
  try {
    const requireEncrypted =
      String(process.env.REQUIRE_ENCRYPTED_ACCESS_TOKEN || "").toLowerCase() === "true";

    const store = await db.store.findUnique({
      where: { shopUrl: shop },
      select: {
        shopUrl: true,
        accessToken: true,
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

    if (!resolvedToken && store?.accessToken && !requireEncrypted) {
      resolvedToken = store.accessToken;
      const encryptedColumns = buildEncryptedTokenColumns(resolvedToken);
      if (encryptedColumns.accessTokenEncrypted) {
        await db.store.update({
          where: { shopUrl: shop },
          data: encryptedColumns,
        });
      }
    }

    if (!resolvedToken && requireEncrypted) {
      throw new Error(`Encrypted token required but missing for shop: ${shop}`);
    }

    if (!store || !resolvedToken) {
      throw new Error(`No active session found for shop: ${shop}`);
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
