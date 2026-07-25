import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const requiredPaths = [
  path.join(root, "web", "generated", "db", "index.js"),
  path.join(root, "web", "db", "schema.db"),
];

const missing = requiredPaths.filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error("[CI_PREFLIGHT_RUNTIME_PARITY] Missing required runtime artifacts:");
  for (const m of missing) console.error(` - ${m}`);
  process.exit(1);
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
  console.error(`[CI_PREFLIGHT_RUNTIME_PARITY] Unsupported Node runtime: ${process.versions.node}`);
  process.exit(1);
}

console.log("[CI_PREFLIGHT_RUNTIME_PARITY] ok");
