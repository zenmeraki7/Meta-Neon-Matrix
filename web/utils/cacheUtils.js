let redisClient = null;

async function getRedis() {
  if (redisClient) return redisClient;
  try {
    const { createClient } = await import("redis");
    const client = createClient({
      socket: {
        host: process.env.REDIS_HOST || "localhost",
        port: process.env.REDIS_PORT || 6379,
      },
      password: process.env.REDIS_PASSWORD || "",
      prefix: "shopify:products:",
    });
    client.on("error", () => {});
    await client.connect().catch(() => {});
    redisClient = client;
    return redisClient;
  } catch {
    return null;
  }
}

export const normalizeQuery = (query) => {
  if (!query) return "";
  return query.trim().toLowerCase();
};

export const setCache = async (key, data, ttl = 3600) => {
  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.set(key, JSON.stringify(data), { EX: ttl });

    if (Array.isArray(data)) {
      const multi = redis.multi();
      for (const product of data) {
        if (product.id) {
          const cleanProductId = product.id.includes("/")
            ? product.id.split("/").pop()
            : product.id;
          multi.sAdd(`index:product:${cleanProductId}`, key);
          multi.expire(`index:product:${cleanProductId}`, ttl);
        }
      }
      await multi.exec().catch(() => {});
    }
  } catch {
    // Fail gracefully
  }
};

export const getCache = async (key) => {
  try {
    const redis = await getRedis();
    if (!redis) return null;
    const cachedData = await redis.get(key);
    return cachedData ? JSON.parse(cachedData) : null;
  } catch {
    return null;
  }
};

export const clearAllCachesForShop = async (shop) => {
  try {
    const redis = await getRedis();
    if (!redis) return true;
    const keys = [];
    for await (const key of redis.scanIterator({ MATCH: `${shop}*`, COUNT: 500 })) {
      keys.push(key);
    }
    if (keys.length > 0) {
      await redis.del(keys);
    }
    return true;
  } catch {
    return true;
  }
};

export const clearKeyCaches = async (key) => {
  try {
    const redis = await getRedis();
    if (!redis) return true;
    const keys = [];
    for await (const redisKey of redis.scanIterator({ MATCH: `${key}*`, COUNT: 500 })) {
      keys.push(redisKey);
    }
    if (keys.length > 0) {
      await redis.del(keys);
    }
    return true;
  } catch {
    return true;
  }
};

export const getRedisClient = () => redisClient;
