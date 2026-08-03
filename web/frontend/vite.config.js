import { defineConfig } from "vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";
import dotenv from "dotenv";

const configDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(configDir, "../../.env") });
dotenv.config({ path: resolve(configDir, "../.env"), override: false });

const isProductionBundle = process.env.npm_lifecycle_event === "build";

if (
  isProductionBundle &&
  !process.env.CI &&
  !process.env.SHOPIFY_API_KEY
) {
  throw new Error(
    "\n\nThe frontend build will not work without an API key. Set the SHOPIFY_API_KEY environment variable when running the build command, for example:" +
      "\n\nSHOPIFY_API_KEY=<your-api-key> npm run build\n"
  );
}

const runtimeShopifyApiKeyPlugin = {
  name: "runtime-shopify-api-key",
  transformIndexHtml(html, context) {
    if (!context?.server) return html;
    return html.replaceAll(
      "__SHOPIFY_API_KEY__",
      process.env.SHOPIFY_API_KEY || "",
    );
  },
};

const plugins = [react(), runtimeShopifyApiKeyPlugin];
if (process.env.BUNDLE_ANALYZE === "true") {
  const { visualizer } = await import("rollup-plugin-visualizer");
  plugins.push(
    visualizer({
      filename: resolve(configDir, "dist/stats.html"),
      gzipSize: true,
      brotliSize: true,
      open: false,
    })
  );
}

const proxyOptions = {
  target: `http://127.0.0.1:${process.env.BACKEND_PORT}`,
  changeOrigin: false,
  secure: true,
  ws: false,
};

const host = process.env.HOST
  ? process.env.HOST.replace(/https?:\/\//, "")
  : "localhost";

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: process.env.FRONTEND_PORT,
    clientPort: 443,
  };
}

export default defineConfig({
  root: configDir,
  plugins,
  resolve: {
    preserveSymlinks: true,
  },
  build: {
    manifest: true,
    target: "es2020",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 300,
  },
  server: {
    host: "localhost",
    port: process.env.FRONTEND_PORT,
    hmr: hmrConfig,
    allowedHosts: true,
    proxy: {
      "^/(\\?.*)?$": proxyOptions,
      "^/api(/|(\\?.*)?$)": proxyOptions,
    },
  },
});
