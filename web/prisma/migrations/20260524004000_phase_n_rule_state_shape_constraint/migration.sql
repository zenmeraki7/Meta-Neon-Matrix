-- Normalize legacy product-target rows before adding the invariant constraint.
UPDATE "AutomaticProductRuleProductState"
SET "productId" = NULLIF(REPLACE("targetIdentity", 'PRODUCT:', ''), '')
WHERE "targetType" = 'PRODUCT'
  AND "productId" IS NULL
  AND "targetIdentity" LIKE 'PRODUCT:%';

UPDATE "AutomaticProductRuleProductState"
SET "variantId" = NULLIF(REPLACE("targetIdentity", 'VARIANT:', ''), '')
WHERE "targetType" = 'VARIANT'
  AND "variantId" IS NULL
  AND "targetIdentity" LIKE 'VARIANT:%';

ALTER TABLE "AutomaticProductRuleProductState"
DROP CONSTRAINT IF EXISTS "AutomaticRuleState_target_shape_chk";

-- NOT VALID keeps migration safe on large/legacy datasets while enforcing the rule for new writes.
ALTER TABLE "AutomaticProductRuleProductState"
ADD CONSTRAINT "AutomaticRuleState_target_shape_chk"
CHECK (
  (
    "targetType" = 'PRODUCT'
    AND "productId" IS NOT NULL
    AND "variantId" IS NULL
    AND "targetIdentity" = 'PRODUCT:' || "productId"
  )
  OR
  (
    "targetType" = 'VARIANT'
    AND "productId" IS NOT NULL
    AND "variantId" IS NOT NULL
    AND "targetIdentity" = 'VARIANT:' || "variantId"
  )
) NOT VALID;
