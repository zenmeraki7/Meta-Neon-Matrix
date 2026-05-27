function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function parseScopes(rawValue) {
  if (!rawValue) return new Set();
  return new Set(
    String(rawValue)
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function getTargetingFeatureFlags() {
  const engineV2Raw = process.env.ENABLE_TARGETING_ENGINE_V2;
  const engineV2Scopes = parseScopes(engineV2Raw);
  const engineV2All = parseBoolean(engineV2Raw, false) || engineV2Scopes.has("ALL");

  return {
    ENABLE_TARGETING_ENGINE_V2: engineV2All || engineV2Scopes.size > 0,
    ENABLE_TARGETING_ENGINE_V2_SCOPES: engineV2Scopes,
    ENABLE_TARGETING_AST_INPUT: parseBoolean(process.env.ENABLE_TARGETING_AST_INPUT, true),
    ENABLE_TARGETING_LEGACY_ADAPTER_READONLY: parseBoolean(
      process.env.ENABLE_TARGETING_LEGACY_ADAPTER_READONLY,
      false,
    ),
    ENABLE_TARGETING_STRICT_VALIDATION: parseBoolean(
      process.env.ENABLE_TARGETING_STRICT_VALIDATION,
      true,
    ),
    ENABLE_TARGETING_PERSIST_VERSIONS: parseBoolean(
      process.env.ENABLE_TARGETING_PERSIST_VERSIONS,
      true,
    ),
  };
}

export function isEngineV2EnabledForFlow(flags, flow) {
  if (!flags?.ENABLE_TARGETING_ENGINE_V2) return false;
  const scopes = flags.ENABLE_TARGETING_ENGINE_V2_SCOPES;
  if (!scopes || scopes.size === 0) return true;
  if (scopes.has("ALL")) return true;
  return scopes.has(String(flow || "").toUpperCase());
}
