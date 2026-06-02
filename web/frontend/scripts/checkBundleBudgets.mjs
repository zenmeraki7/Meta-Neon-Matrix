import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const distAssetsDir = join(process.cwd(), "dist", "assets");
const JS_BUDGET_KB = Number(process.env.BUNDLE_BUDGET_JS_KB || 350);
const CSS_BUDGET_KB = Number(process.env.BUNDLE_BUDGET_CSS_KB || 120);
const INITIAL_CHUNK_BUDGET_KB = Number(process.env.BUNDLE_BUDGET_INITIAL_CHUNK_KB || 220);
const MAX_VENDOR_CHUNK_KB = Number(process.env.BUNDLE_BUDGET_VENDOR_CHUNK_KB || 180);
const MAX_ROUTE_CHUNK_KB = Number(process.env.BUNDLE_BUDGET_ROUTE_CHUNK_KB || 140);

function bytesToKb(bytes) {
  return Math.round((bytes / 1024) * 10) / 10;
}

function getFiles() {
  const files = readdirSync(distAssetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = join(distAssetsDir, entry.name);
      const size = statSync(filePath).size;
      return { name: entry.name, size };
    });
  return files;
}

function sumByExt(files, ext) {
  return files
    .filter((file) => file.name.endsWith(ext))
    .reduce((sum, file) => sum + file.size, 0);
}

function main() {
  const files = getFiles();
  const jsTotalKb = bytesToKb(sumByExt(files, ".js"));
  const cssTotalKb = bytesToKb(sumByExt(files, ".css"));

  const initialChunk = files
    .filter((file) => file.name.includes("index") && file.name.endsWith(".js"))
    .sort((a, b) => b.size - a.size)[0];
  const initialChunkKb = initialChunk ? bytesToKb(initialChunk.size) : 0;

  const failures = [];
  if (jsTotalKb > JS_BUDGET_KB) {
    failures.push(`Total JS budget exceeded: ${jsTotalKb}KB > ${JS_BUDGET_KB}KB`);
  }
  if (cssTotalKb > CSS_BUDGET_KB) {
    failures.push(`Total CSS budget exceeded: ${cssTotalKb}KB > ${CSS_BUDGET_KB}KB`);
  }
  if (initialChunkKb > INITIAL_CHUNK_BUDGET_KB) {
    failures.push(
      `Initial chunk budget exceeded: ${initialChunkKb}KB > ${INITIAL_CHUNK_BUDGET_KB}KB (${initialChunk?.name || "n/a"})`,
    );
  }

  const oversizedVendorChunks = files
    .filter((file) => file.name.endsWith(".js") && file.name.includes("vendor-"))
    .map((file) => ({ ...file, sizeKb: bytesToKb(file.size) }))
    .filter((file) => file.sizeKb > MAX_VENDOR_CHUNK_KB);

  const oversizedRouteChunks = files
    .filter((file) => file.name.endsWith(".js") && file.name.includes("route-"))
    .map((file) => ({ ...file, sizeKb: bytesToKb(file.size) }))
    .filter((file) => file.sizeKb > MAX_ROUTE_CHUNK_KB);

  oversizedVendorChunks.forEach((file) => {
    failures.push(
      `Vendor chunk budget exceeded: ${file.sizeKb}KB > ${MAX_VENDOR_CHUNK_KB}KB (${file.name})`,
    );
  });

  oversizedRouteChunks.forEach((file) => {
    failures.push(
      `Route chunk budget exceeded: ${file.sizeKb}KB > ${MAX_ROUTE_CHUNK_KB}KB (${file.name})`,
    );
  });

  const report = [
    `Bundle report: JS=${jsTotalKb}KB CSS=${cssTotalKb}KB initial=${initialChunkKb}KB`,
    `Budgets: JS<=${JS_BUDGET_KB}KB CSS<=${CSS_BUDGET_KB}KB initial<=${INITIAL_CHUNK_BUDGET_KB}KB vendor<=${MAX_VENDOR_CHUNK_KB}KB route<=${MAX_ROUTE_CHUNK_KB}KB`,
  ];
  report.forEach((line) => console.log(line));

  if (failures.length > 0) {
    failures.forEach((failure) => console.error(failure));
    process.exit(1);
  }
}

main();
