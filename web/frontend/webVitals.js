import { onCLS, onINP, onLCP, onTTFB, onFCP } from "web-vitals";
import { emitPerformanceTelemetry } from "./utils/performanceTelemetry";

function toRouteGroup(pathname) {
  const path = String(pathname || "/");
  if (path.startsWith("/products")) return "products";
  if (path.startsWith("/history")) return "history";
  if (path.startsWith("/export")) return "exports";
  if (path.startsWith("/edit")) return "bulk_preview";
  if (path.startsWith("/refresh")) return "sync";
  return "unknown";
}

function sendWebVital(metric) {
  const metricName = String(metric?.name || "").toUpperCase();
  const metricValue = Number(metric?.value);
  const clsMs = metricName === "CLS" ? metricValue * 1000 : metricValue;

  emitPerformanceTelemetry({
    eventType: "web_vital",
    metricName,
    valueMs: clsMs,
    rating: metric?.rating || "unknown",
    routeGroup: toRouteGroup(window?.location?.pathname),
    status: "ok",
    success: true,
  });
}

export function reportWebVitals(callback) {
  const emit = (metric) => {
    callback?.(metric);
    if (import.meta.env.PROD) {
      sendWebVital(metric);
    }
  };

  try {
    onCLS(emit);
    onLCP(emit);
    onINP(emit);
    onTTFB(emit);
    onFCP(emit);
   } catch (err) {
    if (import.meta.env.DEV) {
      console.error("Web vitals error", err);
    }
  }
}

   
 
