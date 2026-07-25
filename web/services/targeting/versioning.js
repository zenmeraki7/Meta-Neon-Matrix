export const TARGETING_COMPILER_VERSION = "2.0.0";
export const FIELD_REGISTRY_VERSION = "2026-05-Phase2-v1";
export const OPERATOR_REGISTRY_VERSION = "2026-05-Phase2-v1";
export const FILTER_AST_VERSION = "2.0.0";

export function getTargetingVersionBundle() {
  return {
    targetingCompilerVersion: TARGETING_COMPILER_VERSION,
    fieldRegistryVersion: FIELD_REGISTRY_VERSION,
    operatorRegistryVersion: OPERATOR_REGISTRY_VERSION,
    filterAstVersion: FILTER_AST_VERSION,
  };
}
