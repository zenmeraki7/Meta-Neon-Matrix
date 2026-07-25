export type Brand<T, Name extends string> = T & {
  readonly __brand: Name;
};

export type StoreId = Brand<string, "StoreId">;
export type ShopDomain = Brand<string, "ShopDomain">;
export type MirrorBatchId = Brand<string, "MirrorBatchId">;
export type ProductGid = Brand<string, "ProductGid">;
export type VariantGid = Brand<string, "VariantGid">;

