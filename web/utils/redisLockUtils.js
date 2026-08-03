import crypto from "crypto";

export function createLockToken() {
  return crypto.randomUUID();
}

const REDIS_READY_TIMEOUT_MS = 10_000;

async function waitForRedisReady(connection) {
  if (!connection || typeof connection.set !== "function") return false;
  if (!connection.status || connection.status === "ready") return true;
  if (["end", "close"].includes(connection.status)) return false;

  return new Promise((resolve) => {
    let settled = false;

    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      connection.removeListener?.("ready", onReady);
      connection.removeListener?.("error", onUnavailable);
      connection.removeListener?.("end", onUnavailable);
      connection.removeListener?.("close", onUnavailable);
      resolve(ready);
    };

    const onReady = () => finish(true);
    const onUnavailable = () => finish(false);
    const timeout = setTimeout(() => finish(false), REDIS_READY_TIMEOUT_MS);

    connection.once?.("ready", onReady);
    connection.once?.("error", onUnavailable);
    connection.once?.("end", onUnavailable);
    connection.once?.("close", onUnavailable);
  });
}

export async function acquireRedisLock({
  connection,
  key,
  ttlMs,
  token = createLockToken(),
}) {
  const ready = await waitForRedisReady(connection);
  if (!ready) {
    return { acquired: false, key, token };
  }

  let claimed = null;
  try {
    claimed = await connection.set(key, token, "NX", "PX", ttlMs);
  } catch {
    // A scheduler lock is best-effort. Redis reconnects must not crash workers.
  }

  return {
    acquired: claimed === "OK",
    key,
    token,
  };
}

export async function renewRedisLock({
  connection,
  key,
  ttlMs,
  token,
}) {
  const lua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    end
    return 0
  `;

  const renewed = await connection.eval(lua, 1, key, token, String(ttlMs));
  return Number(renewed) === 1;
}

export async function releaseRedisLock({
  connection,
  key,
  token,
}) {
  const lua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    end
    return 0
  `;

  const released = await connection.eval(lua, 1, key, token);
  return Number(released) === 1;
}
