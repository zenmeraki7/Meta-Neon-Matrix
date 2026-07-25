import crypto from "crypto";

export function createLockToken() {
  return crypto.randomUUID();
}

export async function acquireRedisLock({
  connection,
  key,
  ttlMs,
  token = createLockToken(),
}) {
  const claimed = await connection.set(key, token, "NX", "PX", ttlMs);
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
