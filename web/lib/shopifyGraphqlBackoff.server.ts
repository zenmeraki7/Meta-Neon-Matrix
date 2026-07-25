// app/lib/shopifyGraphqlBackoff.server.ts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("SHOPIFY_GRAPHQL_TIMEOUT")), ms)
    ),
  ]);
}

export async function shopifyGraphqlWithBackoff({
  adminGraphql,
  query,
  variables,
  timeoutMs = 45_000,
  maxAttempts = 5,
  minimumAvailable = 100,
}: {
  adminGraphql: any;
  query: string;
  variables: Record<string, unknown>;
  timeoutMs?: number;
  maxAttempts?: number;
  minimumAvailable?: number;
}) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await timeout<{ json(): Promise<any> }>(
        adminGraphql(query, { variables }),
        timeoutMs
      );

      const json = await response.json();

      const throttle = json.extensions?.cost?.throttleStatus;
      const errors = json.errors ?? [];

      if (
        errors.some((e: any) =>
          String(e.message || "")
            .toLowerCase()
            .includes("throttled")
        )
      ) {
        const restoreRate = throttle?.restoreRate || 50;
        await sleep(
          Math.min(10_000, Math.ceil((minimumAvailable / restoreRate) * 1000))
        );
        continue;
      }

      if (throttle && throttle.currentlyAvailable < minimumAvailable) {
        const restoreRate = throttle.restoreRate || 50;
        const waitMs = Math.ceil(
          ((minimumAvailable - throttle.currentlyAvailable) / restoreRate) *
            1000
        );
        await sleep(Math.min(waitMs, 10_000));
      }

      return json;
    } catch (error) {
      lastError = error;
      await sleep(Math.min(30_000, 2_000 * attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("SHOPIFY_GRAPHQL_FAILED");
}
