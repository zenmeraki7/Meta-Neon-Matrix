import { useMemo } from "react";
import { useTranslation } from "react-i18next";

export function useLocaleFormatters() {
  const { i18n } = useTranslation();
  const locale = i18n.language || "en";

  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(locale),
    [locale],
  );

  return { locale, dateTimeFormatter, numberFormatter };
}

