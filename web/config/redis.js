// web/config/redis.js
import EventEmitter from "events";

let IORedisClass = null;

try {
  const ioredis = await import("ioredis");
  IORedisClass = ioredis.default || ioredis;
} catch {
  IORedisClass = class DummyIORedis extends EventEmitter {
    constructor() {
      super();
    }
    async get() { return null; }
    async setex() { return "OK"; }
    async del() { return 1; }
  };
}

export function createRedisConnection() {
  try {
    if (process.env.REDIS_URL) {
      return new IORedisClass(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
      });
    }

    return new IORedisClass({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  } catch {
    return new IORedisClass();
  }
}

export const connection = createRedisConnection();

if (connection && typeof connection.on === "function") {
  connection.on("connect", () => {});
  connection.on("error", () => {});
}

class DummyMetric {
  inc() {}
  startTimer() {
    return () => {};
  }
}

export const redisMetrics = {
  hits: new DummyMetric(),
  misses: new DummyMetric(),
  errors: new DummyMetric(),
  latency: new DummyMetric(),
};

export const redisClient = {
  async get(key) {
    try {
      return await connection.get(key);
    } catch {
      return null;
    }
  },
  async setEx(key, ttl, value) {
    try {
      return await connection.setex(key, ttl, value);
    } catch {
      return null;
    }
  },
  async del(key) {
    try {
      return await connection.del(key);
    } catch {
      return null;
    }
  },
};
