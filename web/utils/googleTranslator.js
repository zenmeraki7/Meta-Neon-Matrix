const LANGUAGES = [
  "en",
  "de",
  "fr",
  "es",
  "ar",
  "hi",
  "zh",
  "ja",
  "ko",
  "pt",
  "ru",
];

let translateInstance = null;

async function getTranslate() {
  if (translateInstance) return translateInstance;
  try {
    try {
      const dotenv = await import("dotenv");
      dotenv.default?.config?.();
    } catch {
      // Ignore missing dotenv in subdirectories
    }

    const { Translate } = await import("@google-cloud/translate/build/src/v2/index.js");
    const credentials = {
      type: process.env.GCP_TYPE,
      project_id: process.env.GCP_PROJECT_ID,
      private_key_id: process.env.GCP_PRIVATE_KEY_ID,
      private_key: process.env.GCP_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      client_email: process.env.GCP_CLIENT_EMAIL,
      client_id: process.env.GCP_CLIENT_ID,
      auth_uri: process.env.GCP_AUTH_URI,
      token_uri: process.env.GCP_TOKEN_URI,
      auth_provider_x509_cert_url: process.env.GCP_AUTH_PROVIDER_X509_CERT_URL,
      client_x509_cert_url: process.env.GCP_CLIENT_X509_CERT_URL,
      universe_domain: process.env.GCP_UNIVERSE_DOMAIN,
    };
    translateInstance = new Translate({ credentials });
    return translateInstance;
  } catch {
    return null;
  }
}

export const createMultiLanguage = async (originalTitle) => {
  const translated = { en: originalTitle };
  const translate = await getTranslate();

  for (const lang of LANGUAGES) {
    if (lang === "en") continue;

    try {
      if (translate) {
        const [translation] = await translate.translate(originalTitle, lang);
        translated[lang] = translation;
      } else {
        translated[lang] = originalTitle;
      }
    } catch {
      translated[lang] = originalTitle;
    }
  }
  return translated;
};

export const createMultiLanguageForFileEdit = (originalTitle) => {
  const translated = { en: originalTitle };
  for (const lang of LANGUAGES) {
    if (lang === "en") continue;
    translated[lang] = originalTitle;
  }
  return translated;
};
