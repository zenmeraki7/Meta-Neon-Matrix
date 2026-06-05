import { createStoreAccessSessionAdapter } from "../services/store/storeAccessSessionAdapter.js";

export function attachStoreAccessDependencies(req, res, next) {
  const session = res.locals.shopify.session;

  res.locals.storeAccessDependencies = createStoreAccessSessionAdapter(session);

  return next();
}

