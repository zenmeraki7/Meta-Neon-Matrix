import { useTranslation } from "react-i18next";

import DemoVideo from "../components/DemoVideo";
import MetamatrixCardGroup from "../components/MetamatrixCardGroup";

function PromotionalContent() {
  const { t } = useTranslation();

  return (
    <s-stack gap="large">
      <MetamatrixCardGroup />

      <s-divider></s-divider>

      <s-section heading={t("demoVideo")}>
        <s-stack alignItems="center">
          <s-box
            inlineSize="100%"
            maxInlineSize="960px"
            paddingBlock="base"
          >
            <DemoVideo />
          </s-box>
        </s-stack>
      </s-section>

      <s-divider></s-divider>
    </s-stack>
  );
}

export default PromotionalContent;