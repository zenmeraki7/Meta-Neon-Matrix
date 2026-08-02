import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppProvider } from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";
import {
  getPolarisTranslations,
  getPolarisTranslationsForLocale,
} from "../../utils/i18nUtils";

function AppBridgeLink({ url, children, external, ...rest }) {
  const navigate = useNavigate();
  const handleClick = useCallback(
    (event) => {
      event.preventDefault();
      navigate(url);
    },
    [navigate, url],
  );

  const IS_EXTERNAL_LINK_REGEX = /^(?:[a-z][a-z\d+.-]*:|\/\/)/;

  if (external || IS_EXTERNAL_LINK_REGEX.test(url)) {
    return (
      <a {...rest} href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }

  return (
    <a {...rest} href={url} onClick={handleClick}>
      {children}
    </a>
  );
}

export function PolarisProvider({ children }) {
  const { i18n } = useTranslation();

  const [translations, setTranslations] = useState(
    () => getPolarisTranslations() || {},
  );

  useEffect(() => {
    let active = true;

    void getPolarisTranslationsForLocale(
      i18n.resolvedLanguage || i18n.language,
    ).then((nextTranslations) => {
      if (active) {
        setTranslations(nextTranslations);
      }
    });

    return () => {
      active = false;
    };
  }, [i18n.language, i18n.resolvedLanguage]);

  return (
    <AppProvider i18n={translations} linkComponent={AppBridgeLink}>
      {children}
    </AppProvider>
  );
}
