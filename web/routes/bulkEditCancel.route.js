import express from "express";
import { z } from "zod";
import { prisma } from "../config/database.js";
import auth from "../middleware/requireSession.js";
import { requireShop } from "../middleware/requireShop.js";
import { recomputeApplyRequestStatus } from "../lib/recomputeApplyStatus.server.js";

const CancelSchema = z
  .object({ bulkApplyJobId: z.string().min(1).max(128) })
  .strict();

export const bulkEditCancelRouter = express.Router();

bulkEditCancelRouter.post(
  "/api/bulk-edit/cancel",
  auth,
  requireShop,
  async (req, res) => {
    const shop = req.shopDomain;
    const parsed = CancelSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid cancel request" });
    }

    const { bulkApplyJobId } = parsed.data;

    await prisma.$transaction(async (tx) => {
      const requests = await tx.bulkApplyRequest.findMany({
        where: {
          shop,
          bulkApplyJobId,
          status: { in: ["QUEUED", "RUNNING", "PARTIAL_FAILED", "FAILED"] },
        },
        select: { id: true },
      });

      for (const request of requests) {
        await tx.bulkApplyItem.updateMany({
          where: {
            shop,
            requestId: request.id,
            status: { in: ["PENDING", "FAILED", "APPLYING"] },
          },
          data: { status: "CANCELLED", finishedAt: new Date() },
        });
        await recomputeApplyRequestStatus({ shop, applyRequestId: request.id, db: tx });
      }
    });

    return res.json({ ok: true });
  },
);
