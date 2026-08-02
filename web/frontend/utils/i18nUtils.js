import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import ShopifyFormat from "@shopify/i18next-shopify";
import resourcesToBackend from "i18next-resources-to-backend";
import { match } from "@formatjs/intl-localematcher";
import { shouldPolyfill as shouldPolyfillLocale } from "@formatjs/intl-locale/should-polyfill";
import { shouldPolyfill as shouldPolyfillPluralRules } from "@formatjs/intl-pluralrules/should-polyfill";
import {
  DEFAULT_LOCALE as DEFAULT_POLARIS_LOCALE,
  SUPPORTED_LOCALES as SUPPORTED_POLARIS_LOCALES,
} from "@shopify/polaris";

const DEFAULT_APP_LOCALE = "en";
export const APP_NAMESPACES = ["common", "products", "history", "subscription", "feedback"];

const SUPPORTED_APP_LOCALES = [
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

let _userLocale;
let _polarisTranslations;
let _initPromise;

function deepMerge(target, source) {
  const output = { ...target };

  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      output[key] = deepMerge(target?.[key] || {}, source[key]);
    } else {
      output[key] = source[key];
    }
  }

  return output;
}

function getStoredLocale() {
  try {
    return window.localStorage.getItem("appLanguage");
  } catch {
    return null;
  }
}

function getShopifyLocaleFromContext() {
  try {
    return window?.shopify?.config?.locale || window?.Shopify?.locale || null;
  } catch {
    return null;
  }
}

export function getUserLocale() {
  if (_userLocale) {
    return _userLocale;
  }

  const explicitLocale = (() => {
    try {
      return new URL(window.location.href).searchParams.get("locale");
    } catch {
      return null;
    }
  })();

  const storedLocale = getStoredLocale();
  const locale = explicitLocale || storedLocale || getShopifyLocaleFromContext() || navigator?.language || DEFAULT_APP_LOCALE;

  _userLocale = match([locale], SUPPORTED_APP_LOCALES, DEFAULT_APP_LOCALE);
  return _userLocale;
}

const _polarisPromises = new Map();

export function getPolarisTranslations() {
  return _polarisTranslations;
}

export async function getPolarisTranslationsForLocale(locale) {
  const defaultPolarisLocale = match([DEFAULT_APP_LOCALE], SUPPORTED_POLARIS_LOCALES, DEFAULT_POLARIS_LOCALE);
  const polarisLocale = match([locale || DEFAULT_APP_LOCALE], SUPPORTED_POLARIS_LOCALES, defaultPolarisLocale);

  if (_polarisPromises.has(polarisLocale)) {
    return _polarisPromises.get(polarisLocale);
  }

  const promise = (async () => {
    const translations = await loadPolarisTranslations(polarisLocale);
    const localeBase = (locale || DEFAULT_APP_LOCALE).split("-")[0];

    const POLARIS_FILTER_ADD_LABELS = {
      en: "Add filter",
      de: "Filter hinzufügen",
      fr: "Ajouter un filtre",
      es: "Agregar filtro",
      ar: "إضافة عامل تصفية",
      hi: "फ़िल्टर जोड़ें",
      ja: "フィルターを追加",
      ko: "필터 추가",
      pt: "Adicionar filtro",
      ru: "Добавить фильтр",
      zh: "添加筛选条件",
    };

    const customPolarisOverrides = POLARIS_FILTER_ADD_LABELS[localeBase]
      ? {
          Polaris: {
            Filters: {
              addFilter: POLARIS_FILTER_ADD_LABELS[localeBase],
            },
          },
        }
      : {};

    _polarisTranslations = deepMerge(translations, customPolarisOverrides);
    return _polarisTranslations;
  })();

  _polarisPromises.set(polarisLocale, promise);
  return promise;
}

export function initI18n() {
  if (_initPromise) {
    return _initPromise;
  }

  _initPromise = (async () => {
    await initI18next();
    void loadIntlPolyfills().catch((error) => {
      console.error("Intl polyfill bootstrap failed", error);
    });

    return i18next;
  })();

  return _initPromise;
}

async function loadIntlPolyfills() {
  if (shouldPolyfillLocale()) {
    await import("@formatjs/intl-locale/polyfill");
  }

  const promises = [];

  if (shouldPolyfillPluralRules(DEFAULT_APP_LOCALE)) {
    await import("@formatjs/intl-pluralrules/polyfill-force");
    promises.push(loadIntlPluralRulesLocaleData(DEFAULT_APP_LOCALE));
  }

  if (DEFAULT_APP_LOCALE !== getUserLocale() && shouldPolyfillPluralRules(getUserLocale())) {
    promises.push(loadIntlPluralRulesLocaleData(getUserLocale()));
  }

  await Promise.all(promises);
}

const PLURAL_RULES_LOCALE_DATA = {
  cs: () => import("@formatjs/intl-pluralrules/locale-data/cs"),
  da: () => import("@formatjs/intl-pluralrules/locale-data/da"),
  de: () => import("@formatjs/intl-pluralrules/locale-data/de"),
  en: () => import("@formatjs/intl-pluralrules/locale-data/en"),
  es: () => import("@formatjs/intl-pluralrules/locale-data/es"),
  fi: () => import("@formatjs/intl-pluralrules/locale-data/fi"),
  fr: () => import("@formatjs/intl-pluralrules/locale-data/fr"),
  it: () => import("@formatjs/intl-pluralrules/locale-data/it"),
  ja: () => import("@formatjs/intl-pluralrules/locale-data/ja"),
  ko: () => import("@formatjs/intl-pluralrules/locale-data/ko"),
  nb: () => import("@formatjs/intl-pluralrules/locale-data/nb"),
  nl: () => import("@formatjs/intl-pluralrules/locale-data/nl"),
  pl: () => import("@formatjs/intl-pluralrules/locale-data/pl"),
  pt: () => import("@formatjs/intl-pluralrules/locale-data/pt"),
  "pt-PT": () => import("@formatjs/intl-pluralrules/locale-data/pt-PT"),
  sv: () => import("@formatjs/intl-pluralrules/locale-data/sv"),
  th: () => import("@formatjs/intl-pluralrules/locale-data/th"),
  tr: () => import("@formatjs/intl-pluralrules/locale-data/tr"),
  vi: () => import("@formatjs/intl-pluralrules/locale-data/vi"),
  zh: () => import("@formatjs/intl-pluralrules/locale-data/zh"),
};

async function loadIntlPluralRulesLocaleData(locale) {
  return (await PLURAL_RULES_LOCALE_DATA[locale]()).default;
}

async function initI18next() {
  if (i18next.isInitialized) {
    return i18next;
  }

  return await i18next
    .use(initReactI18next)
    .use(ShopifyFormat)
    .use(resourcesToBackend((lng, ns) => import(`../locales/${lng}/${ns}.json`)))
    .init({
      debug: import.meta.env.DEV,
      lng: getUserLocale(),
      fallbackLng: DEFAULT_APP_LOCALE,
      supportedLngs: SUPPORTED_APP_LOCALES,
      ns: ["common"],
      preload: ["common"],
      defaultNS: "common",
      fallbackNS: "common",
      interpolation: {
        escapeValue: false,
      },
      react: {
        useSuspense: false,
      },
      partialBundledLanguages: true,
    });
}


const POLARIS_LOCALE_DATA = {
  cs: () => import("@shopify/polaris/locales/cs.json"),
  da: () => import("@shopify/polaris/locales/da.json"),
  de: () => import("@shopify/polaris/locales/de.json"),
  en: () => import("@shopify/polaris/locales/en.json"),
  es: () => import("@shopify/polaris/locales/es.json"),
  fi: () => import("@shopify/polaris/locales/fi.json"),
  fr: () => import("@shopify/polaris/locales/fr.json"),
  it: () => import("@shopify/polaris/locales/it.json"),
  ja: () => import("@shopify/polaris/locales/ja.json"),
  ko: () => import("@shopify/polaris/locales/ko.json"),
  nb: () => import("@shopify/polaris/locales/nb.json"),
  nl: () => import("@shopify/polaris/locales/nl.json"),
  pl: () => import("@shopify/polaris/locales/pl.json"),
  "pt-BR": () => import("@shopify/polaris/locales/pt-BR.json"),
  "pt-PT": () => import("@shopify/polaris/locales/pt-PT.json"),
  sv: () => import("@shopify/polaris/locales/sv.json"),
  th: () => import("@shopify/polaris/locales/th.json"),
  tr: () => import("@shopify/polaris/locales/tr.json"),
  vi: () => import("@shopify/polaris/locales/vi.json"),
  "zh-CN": () => import("@shopify/polaris/locales/zh-CN.json"),
  "zh-TW": () => import("@shopify/polaris/locales/zh-TW.json"),
};

async function loadPolarisTranslations(locale) {
  return (await POLARIS_LOCALE_DATA[locale]()).default;
}

export { i18next as i18n };
