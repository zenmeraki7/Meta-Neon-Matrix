export function buildAutomaticRuleTargetIdentity({ targetType, productId, variantId }) {
  if (targetType === "PRODUCT") {
    if (!productId) {
      throw new Error("PRODUCT automatic rule target requires productId");
    }

    return `PRODUCT:${productId}`;
  }

  if (targetType === "VARIANT") {
    if (!productId || !variantId) {
      throw new Error("VARIANT rule target requires productId and variantId");
    }

    return `VARIANT:${variantId}`;
  }

  throw new Error(`Unsupported automatic rule target type: ${targetType}`);
}

export function assertAutomaticRuleTargetShape({ rule, target }) {
  if (rule?.scopeType === "PRODUCT") {
    if (!target?.productId || target?.variantId) {
      throw new Error("PRODUCT scoped rule must target productId only");
    }
  }

  if (rule?.scopeType === "VARIANT") {
    if (!target?.productId || !target?.variantId) {
      throw new Error("VARIANT scoped rule must target productId and variantId");
    }
  }
}

export function buildAutomaticRuleScopedTargets(rule, product) {
  if (rule?.scopeType === "VARIANT") {
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    return variants
      .map((variant) => {
        if (!variant?.id) return null;
        const targetType = "VARIANT";
        const target = {
          productId: product.id,
          variantId: variant.id,
        };
        assertAutomaticRuleTargetShape({ rule, target });
        return {
          targetType,
          targetIdentity: buildAutomaticRuleTargetIdentity({
            targetType,
            productId: product.id,
            variantId: variant.id,
          }),
          productId: product.id,
          variantId: variant.id,
          productForFingerprint: {
            ...product,
            variants: [variant],
          },
        };
      })
      .filter(Boolean);
  }

  const targetType = "PRODUCT";
  const target = {
    productId: product.id,
    variantId: null,
  };
  assertAutomaticRuleTargetShape({ rule, target });

  return [
    {
      targetType,
      targetIdentity: buildAutomaticRuleTargetIdentity({
        targetType,
        productId: product.id,
      }),
      productId: product.id,
      variantId: null,
      productForFingerprint: product,
    },
  ];
}
