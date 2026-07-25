import React, { useState } from "react";
import {
  TopBar,
  TextField,
  Icon,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { useTranslation } from "react-i18next";

export function Header() {
  const { t } = useTranslation();
  const [searchValue, setSearchValue] = useState("");

  
  const handleSearchChange = (value) => setSearchValue(value);

  return (
    <TopBar
      showNavigationToggle
      secondaryMenu={
        <TextField
          label={t("searchButton")}
          labelHidden
          value={searchValue}
          onChange={handleSearchChange}
          placeholder={t("searchPlaceholder")}
          prefix={<Icon source={SearchIcon} tone={"subdued"} />}
          autoComplete={"off"}
        />
      }
    />
  );
}
