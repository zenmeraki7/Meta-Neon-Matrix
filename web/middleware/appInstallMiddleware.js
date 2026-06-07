import { addAppInstallationJob } from "../Jobs/Queues/appInstallationJob.js";
import { getReferralEmailContent } from "../config/templates/referralTemplate.js";
import {
  adminInstallNotificationHTML,
  welcomeEmailHTML,
} from "../config/templates/welcomeTemplate.js";
import { sendEmail } from "../utils/emailHelper.js";
import { generateReferralCode } from "../utils/referralUtils.js";
import { clearKeyCaches } from "../utils/cacheUtils.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { db } from "../repositories/repositoryDb.js";
import shopify from "../shopify.js";
import { buildEncryptedTokenColumns } from "../utils/tokenCrypto.js";
import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/*  Email helpers (called from worker)                                 */
/* ------------------------------------------------------------------ */

export const sentWelcomeMailToStore = async ({ email, shopOwner, shop }) => {
  const subject = "🎉 Welcome to Metamatrix!";
  const formatedShop = shop.split(".")[0];
  const htmlMessage = welcomeEmailHTML(shopOwner, formatedShop);
  await sendEmail(email, subject, htmlMessage, true);
};

export const sentInstalledMailToAdmin = async ({ email, shop }) => {
  const subject = "🎉 New Metamatrix Installation";
  const formatedShop = shop.split(".")[0];
  const adminEmail = "zenmerakihelp@gmail.com";
  const htmlMessage = adminInstallNotificationHTML(
    shop,
    email,
    formatedShop,
    new Date().toDateString()
  );
  await sendEmail(adminEmail, subject, htmlMessage, true);
};

/* ------------------------------------------------------------------ */
/*  Full store setup (called from worker, after middleware upsert)     */
/* ------------------------------------------------------------------ */

export const confirmShopInstallation = async ({
  session,
  email,
  shop,
  accessToken,
  installationGeneration,
}) => {
  // The store row already exists (created by middleware upsert).
  // Check if this is a new install by whether referralCode has been set yet.
  const existingStore = await db.store.findFirst({
    where: {
      shopUrl: shop,
      installationGeneration,
      isUnInstalled: false,
    },
    select: { referralCode: true, referredBy: true },
  });
  if (!existingStore) {
    throw new Error("STALE_INSTALLATION_GENERATION");
  }

  const isNewInstall = !existingStore?.referralCode;

  if (isNewInstall) {
    // Lookup any referral code that was saved during shopPreInstallation
    const latestReferral = await db.referralCode.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
    });

    const newReferralCode = generateReferralCode(shop);

    // Patch the store row with full referral + email data
    const updateResult = await db.store.updateMany({
      where: {
        shopUrl: shop,
        installationGeneration,
        isUnInstalled: false,
      },
      data: {
        shopEmail: email,
        ...buildEncryptedTokenColumns(accessToken),
        scope: session.scope,
        referralCode: newReferralCode,
        referralLink: `https://zenmeraki.com/metamatrix-app?ref=${newReferralCode}`,
        referredBy: latestReferral?.referralCode ?? null,
        refRewardExpiresAt: latestReferral
          ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          : null,
      },
    });
    if (updateResult.count === 0) {
      throw new Error("STALE_INSTALLATION_GENERATION");
    }
    const updatedStore = await db.store.findUnique({
      where: { shopUrl: shop },
      select: { referredBy: true },
    });

    // Notify affiliate if referred
    if (updatedStore.referredBy) {
      let referredUser = null;
      try {
        referredUser = await db.affiliateUser.update({
          where: { referralCode: updatedStore.referredBy },
          data: { numberOfReferrals: { increment: 1 } },
        });
      } catch (e) {
        if (e.code !== "P2025") throw e; // ignore "not found", rethrow anything else
      }

      if (referredUser) {
        const subject =
          "🎉 Great News! A New Store Installed MetaMatrix Using Your Referral";
        const emailContent = getReferralEmailContent({ referredUser, shop });
        await sendEmail(referredUser.email, subject, emailContent, true);
      }
    }

    // Clean up the temporary referral code row
    await db.referralCode.deleteMany({ where: { shop } });
  } else {
    // Reinstall — just refresh credentials + email
    const updateResult = await db.store.updateMany({
      where: {
        shopUrl: shop,
        installationGeneration,
        isUnInstalled: false,
      },
      data: {
        ...buildEncryptedTokenColumns(accessToken),
        shopEmail: email,
        scope: session.scope,
        isUnInstalled: false,
        unInstalledAt: null,
      },
    });
    if (updateResult.count === 0) {
      throw new Error("STALE_INSTALLATION_GENERATION");
    }
  }

  await clearKeyCaches(`${shop}:storeDetails`);
  await clearKeyCaches(`${shop}:sync_details`);
};

/* ------------------------------------------------------------------ */
/*  Pre-install: capture referral code before OAuth begins             */
/* ------------------------------------------------------------------ */

export const shopPreInstallation = async (req, res, next) => {
  try {
    return next();
  } catch (error) {
    throw error;
  }
};

/* ------------------------------------------------------------------ */
/*  OAuth callback middleware — MUST return in < ~5s                   */
/* ------------------------------------------------------------------ */

export const appInstallMiddleware = async (req, res, next) => {
  const session = res.locals.shopify?.session;

  try {
    if (!session) {
      return res.status(401).send("Shopify session missing");
    }

    const { shop, accessToken } = session;
    const installationGeneration = randomUUID();

    // ✅ Bare-minimum DB write so the app has a valid store row
    //    before the browser lands on the dashboard.
    await db.store.upsert({
      where: { shopUrl: shop },
      create: {
        shopUrl: shop,
        ...buildEncryptedTokenColumns(accessToken),
        shopEmail: null,
        isUnInstalled: false,
        unInstalledAt: null,
        scope: session.scope,
        installedAt: null,
        installationGeneration,
        installationStatus: "pending",
        installationProcessingStartedAt: null,
        installationSetupCompletedAt: null,
      },
      update: {
        ...buildEncryptedTokenColumns(accessToken),
        isUnInstalled: false,
        unInstalledAt: null,
        installedAt: null,
        installationGeneration,
        installationStatus: "pending",
        installationProcessingStartedAt: null,
        installationSetupCompletedAt: null,
      },
    });

    // Redirect immediately. Background setup should never block OAuth callback.
    next();

    setImmediate(async () => {
      try {
        await clearKeyCaches(`${shop}:storeDetails`);
        await clearKeyCaches(`${shop}:sync_details`);

        if (typeof shopify.registerWebhooks === "function") {
          await shopify.registerWebhooks({ session });
        }

        await addAppInstallationJob({
          version: 1,
          shop,
          installationGeneration,
          requestedBy: "oauth",
        });
      } catch (backgroundError) {
        await logApiError({
          shop,
          err: backgroundError,
          req,
          source: "appInstallMiddleware.backgroundSetup",
        }).catch(() => {});

        console.error("App install background setup error:", backgroundError);
      }
    });
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "appInstallMiddleware",
    });
    console.error("App install error:", err);
    res.status(500).send("Installation failed");
  }
};
