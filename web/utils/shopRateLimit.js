export async function enforceShopRateLimit({
  connection,
  shop,
  scope,
  max = 10,
  durationMs = 1000,
}) {
  if (!connection || !shop || !scope) return;
  const key = `rl:${scope}:${shop}`;
  const current = await connection.incr(key);
  if (current === 1) {
    await connection.pexpire(key, durationMs);
  }
  if (current > max) {
    const waitMs = Math.max(250, Math.floor(durationMs / 2));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

