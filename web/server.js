import dotenv from "dotenv";
import http from "http";
import { Server } from "socket.io";
import { buildApp } from "./app.js";
import db from "./repositories/repositoryDb.js";
import { connection as redis } from "./config/redis.js";
import logger from "./utils/loggerUtils.js";

dotenv.config();

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
    await Promise.allSettled([
      db.$disconnect(),
      redis.quit().catch(() => redis.disconnect()),
    ]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, () => {
  logger.info(`Web server ${process.pid} listening on http://localhost:${PORT}`);
});

