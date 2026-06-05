import { FIELD_TRANSLATIONS } from "../../../config/constants.js";
import {
  buildProductInclude,
  hydrateMissingVariantsForProducts,
  normalizeMirrorProductForPreview,
  normalizeMirrorVariantForPreview,
  PREVIEW_PRODUCT_SELECT,
  PREVIEW_VARIANT_SELECT,
} from "../../bulkEdit/bulkEditTargetUtils.js";
import {
  isVariantLevelField,
  normalizeField,
} from "../../bulkEdit/bulkEditRuleUtils.js";

export {
  buildProductInclude,
  hydrateMissingVariantsForProducts,
  isVariantLevelField,
  normalizeField,
  normalizeMirrorProductForPreview,
  normalizeMirrorVariantForPreview,
  PREVIEW_PRODUCT_SELECT,
  PREVIEW_VARIANT_SELECT,
  FIELD_TRANSLATIONS,
};
