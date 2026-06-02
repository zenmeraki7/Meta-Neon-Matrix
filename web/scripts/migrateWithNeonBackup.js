import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: true,
    ...options,
  });
  return result.status === 0;
}

function nowStamp() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${day}${hh}${mm}${ss}`;
}

function parseBranchArg(argv) {
  const explicit = argv.find((token) => token.startsWith("--branch="));
  if (explicit) return explicit.slice("--branch=".length).trim();
  const idx = argv.findIndex((token) => token === "--branch");
  if (idx >= 0 && argv[idx + 1]) return String(argv[idx + 1]).trim();
  return "";
}

const providedBranch = parseBranchArg(process.argv.slice(2));
const backupBranch = providedBranch || `pre-migration-backup-${nowStamp()}`;

console.log(`[safe-migrate] backup branch: ${backupBranch}`);

if (!run("neon", ["--version"])) {
  console.error("[safe-migrate] Neon CLI is required but not available in PATH.");
  process.exit(1);
}

if (!run("npx", ["db", "--version"])) {
  console.error("[safe-migrate] Prisma CLI is required but not available.");
  process.exit(1);
}

if (!run("neon", ["branch", "create", "--name", backupBranch])) {
  console.error("[safe-migrate] Failed to create Neon backup branch. Migration aborted.");
  process.exit(1);
}

if (!run("npx", ["db", "migrate", "deploy", "--schema", "./db/schema.db"])) {
  console.error("[safe-migrate] Migration failed.");
  console.error(`[safe-migrate] Rollback command: neon branch set-as-primary ${backupBranch}`);
  process.exit(1);
}

console.log("[safe-migrate] Migration deployed successfully.");
console.log(`[safe-migrate] Instant rollback: neon branch set-as-primary ${backupBranch}`);

