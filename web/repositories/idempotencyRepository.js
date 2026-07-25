import { prisma } from "../config/database.js";
import { IdempotencyStoreService } from "../services/idempotency/IdempotencyStoreService.js";

export function createIdempotencyStore() {
  return new IdempotencyStoreService(prisma);
}
