// app/lib/shopLock.server.ts
import crypto from "node:crypto";

const LOCK_TTL_MS = 60_000;
const RENEW_MS = 20_000;

export async function withRenewingShopLock<T>({
  redis,
  shop,
  purpose,
  onLocked,
  fn,
}: {
  redis: any;
  shop: string;
  purpose: string;
  onLocked: () => Promise<T>;
  fn: () => Promise<T>;
}) {
  const key = `lock:${purpose}:${shop}`;
  const token = crypto.randomUUID();

  const locked = await redis.set(key, token, "PX", LOCK_TTL_MS, "NX");

  if (!locked) {
    return onLocked();
  }

  const interval = setInterval(async () => {
    const current = await redis.get(key);
    if (current === token) {
      await redis.pexpire(key, LOCK_TTL_MS);
    }
  }, RENEW_MS);

  try {
    return await fn();
  } finally {
    clearInterval(interval);
    const current = await redis.get(key);
    if (current === token) {
      await redis.del(key);
    }
  }
}