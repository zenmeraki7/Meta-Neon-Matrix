import crypto from "crypto";

function sortObjectDeep(value) {
  if (Array.isArray(value)) return value.map(sortObjectDeep);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObjectDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function hashFilterAst(ast) {
  const canonical = JSON.stringify(sortObjectDeep(ast));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
