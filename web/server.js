import "dotenv/config";
import http from "node:http";
import { Server } from "socket.io";
import { buildApp } from "./app.js";
import db from "./repositories/repositoryDb.js";
import { connection as redis } from "./config/redis.js";
import logger from "./utils/loggerUtils.js";
import { scheduleReconciliationJob } from "./Jobs/Queues/reconciliationJob.js";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const server = http.createServer();
const io = new Server(server, { cors: { origin: "*" } });
const app = buildApp(server, io);
server.on("request", app);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Web process ${process.pid} received ${signal}; shutting down`);
  server.close(async () => {
    await Promise.allSettled([db.$disconnect(), redis.quit().catch(() => redis.disconnect())]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await scheduleReconciliationJob().catch((error) => {
  logger.error("Reconciliation schedule registration failed", { message: error.message });
});

server.listen(PORT, () => {
  logger.info(`Web server ${process.pid} listening on http://localhost:${PORT}`);
});
