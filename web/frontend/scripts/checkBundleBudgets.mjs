import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const distDir = join(process.cwd(), "dist");
const distAssetsDir = join(distDir, "assets");

const JS_BUDGET_KB = Number(process.env.BUNDLE_BUDGET_JS_KB || 650);
const CSS_BUDGET_KB = Number(process.env.BUNDLE_BUDGET_CSS_KB || 450);
const INITIAL_CHUNK_BUDGET_KB = Number(process.env.BUNDLE_BUDGET_INITIAL_CHUNK_KB || 650);
const MAX_VENDOR_CHUNK_KB = Number(process.env.BUNDLE_BUDGET_VENDOR_CHUNK_KB || 180);
const MAX_ROUTE_CHUNK_KB = Number(process.env.BUNDLE_BUDGET_ROUTE_CHUNK_KB || 140);

function bytesToKb(bytes) {
  return Math.round((bytes / 1024) * 10) / 10;
}

function getManifest() {
  const manifestPath = join(distDir, ".vite", "manifest.json");
  const fallbackPath = join(distDir, "manifest.json");

  let targetPath = null;
  if (existsSync(manifestPath)) {
    targetPath = manifestPath;
  } else if (existsSync(fallbackPath)) {
    targetPath = fallbackPath;
  }

  if (!targetPath) {
    throw new Error("manifest.json not found in dist. Ensure build.manifest is true in vite.config.js.");
  }

  return JSON.parse(readFileSync(targetPath, "utf8"));
}

function getEmittedFiles() {
  if (!existsSync(distAssetsDir)) return [];
  return readdirSync(distAssetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = join(distAssetsDir, entry.name);
      const size = statSync(filePath).size;
      return { name: entry.name, path: filePath, size };
    });
}

function sumByExt(files, ext) {
  return files
    .filter((file) => file.name.endsWith(ext))
    .reduce((sum, file) => sum + file.size, 0);
}

function main() {
  const manifest = getManifest();
  const emittedFiles = getEmittedFiles();

  const totalEmittedJsKb = bytesToKb(sumByExt(emittedFiles, ".js"));
  const totalEmittedCssKb = bytesToKb(sumByExt(emittedFiles, ".css"));

  const entryItem = Object.values(manifest).find((item) => item.isEntry) ||
    manifest["index.html"] ||
    manifest["index.jsx"];

  if (!entryItem) {
    throw new Error("No entry point found in manifest.json.");
  }

  const staticJsFiles = new Set();
  const staticCssFiles = new Set();

  function visit(key) {
    const item = manifest[key];
    if (!item) return;

    if (item.file && item.file.endsWith(".js")) {
      staticJsFiles.add(item.file);
    }

    if (Array.isArray(item.css)) {
      item.css.forEach((cssFile) => staticCssFiles.add(cssFile));
    }

    if (Array.isArray(item.imports)) {
      item.imports.forEach((importedKey) => {
        if (!staticJsFiles.has(importedKey)) {
          visit(importedKey);
        }
      });
    }
  }

  const entryKey = Object.keys(manifest).find((k) => manifest[k] === entryItem) || "index.html";
  visit(entryKey);

  let initialJsBytes = 0;
  staticJsFiles.forEach((relFile) => {
    const fullPath = join(distDir, relFile);
    if (existsSync(fullPath)) {
      initialJsBytes += statSync(fullPath).size;
    }
  });

  let initialCssBytes = 0;
  staticCssFiles.forEach((relFile) => {
    const fullPath = join(distDir, relFile);
    if (existsSync(fullPath)) {
      initialCssBytes += statSync(fullPath).size;
    }
  });

  const initialJsKb = bytesToKb(initialJsBytes);
  const initialCssKb = bytesToKb(initialCssBytes);
  const initialChunkKb = entryItem.file && existsSync(join(distDir, entryItem.file))
    ? bytesToKb(statSync(join(distDir, entryItem.file)).size)
    : initialJsKb;

  const failures = [];
  if (initialJsKb > JS_BUDGET_KB) {
    failures.push(`Initial JS budget exceeded: ${initialJsKb}KB > ${JS_BUDGET_KB}KB`);
  }
  if (initialCssKb > CSS_BUDGET_KB) {
    failures.push(`Initial CSS budget exceeded: ${initialCssKb}KB > ${CSS_BUDGET_KB}KB`);
  }
  if (initialChunkKb > INITIAL_CHUNK_BUDGET_KB) {
    failures.push(
      `Initial entry chunk budget exceeded: ${initialChunkKb}KB > ${INITIAL_CHUNK_BUDGET_KB}KB (${entryItem.file || "n/a"})`,
    );
  }

  const oversizedVendorChunks = emittedFiles
    .filter((file) => file.name.endsWith(".js") && file.name.includes("vendor-"))
    .map((file) => ({ ...file, sizeKb: bytesToKb(file.size) }))
    .filter((file) => file.sizeKb > MAX_VENDOR_CHUNK_KB);

  const oversizedRouteChunks = emittedFiles
    .filter(
      (file) =>
        file.name.endsWith(".js") &&
        (file.name.includes("route-") ||
          Object.values(manifest).some(
            (item) => item.isDynamicEntry && item.file?.endsWith(file.name) && item.src?.includes("pages/"),
          )),
    )
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
    `Bundle report: Initial JS=${initialJsKb}KB, Initial CSS=${initialCssKb}KB, Entry Chunk=${initialChunkKb}KB (Total Emitted Assets: JS=${totalEmittedJsKb}KB, CSS=${totalEmittedCssKb}KB)`,
    `Budgets: Initial JS<=${JS_BUDGET_KB}KB, Initial CSS<=${CSS_BUDGET_KB}KB, Entry Chunk<=${INITIAL_CHUNK_BUDGET_KB}KB, Vendor<=${MAX_VENDOR_CHUNK_KB}KB, Route<=${MAX_ROUTE_CHUNK_KB}KB`,
  ];
  report.forEach((line) => console.log(line));

  if (failures.length > 0) {
    failures.forEach((failure) => console.error(failure));
    process.exit(1);
  }
}

main();
