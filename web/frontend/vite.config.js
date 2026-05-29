import { defineConfig } from "vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";
import dotenv from "dotenv";
import { visualizer } from "rollup-plugin-visualizer";

const configDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(configDir, "../../.env") });
dotenv.config({ path: resolve(configDir, "../.env"), override: false });

if (
  process.env.npm_lifecycle_event === "build" &&
  !process.env.CI &&
  !process.env.SHOPIFY_API_KEY
) {
  throw new Error(
    "\n\nThe frontend build will not work without an API key. Set the SHOPIFY_API_KEY environment variable when running the build command, for example:" +
      "\n\nSHOPIFY_API_KEY=<your-api-key> npm run build\n"
  );
}

process.env.VITE_SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;

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
  plugins: [
    react(),
    process.env.BUNDLE_ANALYZE === "true"
      ? visualizer({
          filename: resolve(configDir, "dist/stats.html"),
          gzipSize: true,
          brotliSize: true,
          open: false,
        })
      : null,
  ].filter(Boolean),
  resolve: {
    preserveSymlinks: true,
  },
  build: {
    target: "es2020",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 300,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            if (id.includes("/Domain/products/exports/") || id.includes("/pages/ExportDetails")) {
              return "route-export";
            }
            if (id.includes("/Domain/History/") || id.includes("/pages/history")) {
              return "route-history";
            }
            if (id.includes("/Domain/products/edit/") || id.includes("/pages/edit")) {
              return "route-edit";
            }
            return null;
          }
          if (id.includes("@shopify/app-bridge")) {
            return "vendor-app-bridge";
          }
          if (id.includes("@shopify/polaris") || id.includes("@shopify/polaris-icons")) {
            return "vendor-polaris";
          }
          if (id.includes("@tanstack/react-query")) {
            return "vendor-react-query";
          }
          if (id.includes("react-router-dom")) {
            return "vendor-router";
          }
          if (id.includes("i18next")) {
            return "vendor-i18n";
          }
          if (id.includes("react") || id.includes("scheduler")) {
            return "vendor-react";
          }
          return "vendor";
        },
      },
    },
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
