import dotenv from "dotenv";
dotenv.config();
import Redis from "ioredis";

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
});

async function clearRedis() {
  try {
    // Total keys
    const totalKeys = await redis.dbsize();

    // Memory info
    const memoryInfo = await redis.info("memory");

    const usedMemoryMatch = memoryInfo.match(
      /used_memory_human:(.+)/,
    );

    const usedMemory = usedMemoryMatch
      ? usedMemoryMatch[1].trim()
      : "Unknown";

    console.log("\n===== Redis Stats =====");
    console.log(`Total Keys: ${totalKeys}`);
    console.log(`Memory Used: ${usedMemory}`);
    console.log("=======================\n");

    // Clear Redis
    await redis.flushall();

    console.log("✅ Redis cleared successfully");
  } catch (error) {
    console.error("❌ Failed to clear Redis:", error);
  } finally {
    await redis.quit();
  }
}

clearRedis();