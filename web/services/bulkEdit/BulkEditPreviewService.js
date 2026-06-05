import { ProductBulkPreviewService as ProductBulkPreviewServiceImpl } from "../productService/ProductBulkPreviewService.js";
import { loadAuthoritativeSubscriptionForShop } from "../subscriptionAuthorityService.js";
import { buildActorContext } from "../../utils/operationContextUtils.js";

function assertPlainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

function normalizePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(safe, max);
}

function resolveSession(sessionOrOptions) {
  return sessionOrOptions?.session || sessionOrOptions || null;
}

function resolveSessionActorId(session) {
  const actor = buildActorContext({
    session,
    fallbackType: "MERCHANT_ADMIN",
  });
  return String(actor?.actorId || "").trim();
}

export class BulkEditPreviewService {
  constructor(sessionOrOptions = {}) {
    const session = resolveSession(sessionOrOptions);
    const shop = String(sessionOrOptions?.shop || session?.shop || "").trim();
    if (!shop || !session?.shop || session.shop !== shop) {
      throw new Error("BULK_EDIT_PREVIEW_REQUIRES_SHOP_SESSION");
    }

    this.shop = shop;
    this.session = session;
    this.previewDelegate =
      sessionOrOptions?.previewDelegate ||
      new ProductBulkPreviewServiceImpl({ session });
  }

  /**
   * Build a manual bulk-edit preview.
   *
   * Required args: field/editedField, editType.
   * Target args: filterAst and/or filterParams, cursor, limit.
   * Edit args: editValue, searchKey, replaceText, supportValue, operationKey, lang.
   */
  async previewBulkEdit(args = {}) {
    const input = assertPlainObject(args, "BULK_EDIT_PREVIEW_INPUT_INVALID");
    if (input.shop && String(input.shop).trim() !== this.shop) {
      throw new Error("BULK_EDIT_PREVIEW_SHOP_MISMATCH");
    }

    const field = String(input.field || input.editedField || "").trim();
    const editType = String(input.editType || "").trim();
    if (!field) {
      throw new Error("BULK_EDIT_PREVIEW_FIELD_REQUIRED");
    }
    if (!editType) {
      throw new Error("BULK_EDIT_PREVIEW_EDIT_TYPE_REQUIRED");
    }

    const actorId = resolveSessionActorId(this.session);
    if (!actorId) {
      throw new Error("ACTOR_ID_REQUIRED_FOR_PREVIEW");
    }

    const authoritativeSubscription = await loadAuthoritativeSubscriptionForShop(this.shop);

    return this.previewDelegate.trackEditProducts({
      field,
      editType,
      editValue: input.editValue,
      filterParams: Array.isArray(input.filterParams) ? input.filterParams : [],
      filterAst:
        input.filterAst && typeof input.filterAst === "object" && !Array.isArray(input.filterAst)
          ? input.filterAst
          : null,
      operationKey: input.operationKey || null,
      cursor: input.cursor || null,
      limit: normalizePositiveInt(input.limit, 20, 250),
      lang: input.lang || "en",
      searchKey: input.searchKey || null,
      replaceText: input.replaceText || null,
      supportValue: input.supportValue,
      subscription: authoritativeSubscription,
      actorId,
    });
  }

  async getPreviewVariantDetails(args = {}) {
    const input = assertPlainObject(args, "BULK_EDIT_PREVIEW_VARIANT_INPUT_INVALID");
    if (input.shop && String(input.shop).trim() !== this.shop) {
      throw new Error("BULK_EDIT_PREVIEW_SHOP_MISMATCH");
    }

    const previewId = String(input.previewId || "").trim();
    const productId = String(input.productId || "").trim();
    if (!previewId) {
      throw new Error("PREVIEW_ID_REQUIRED");
    }
    if (!productId) {
      throw new Error("PRODUCT_ID_REQUIRED");
    }

    return this.previewDelegate.getPreviewVariantDetails({
      previewId,
      productId,
      page: normalizePositiveInt(input.page, 1, 100000),
      limit: normalizePositiveInt(input.limit, 50, 250),
      actorId: resolveSessionActorId(this.session) || null,
    });
  }
}
