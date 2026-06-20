import express from "express";
import { z } from "zod";
import { prisma } from "../config/database.js";
import auth from "../middleware/requireSession.js";
import { requireShop } from "../middleware/requireShop.js";

const CancelSchema = z
  .object({
    bulkJobId: z.string().min(1).max(128),
  })
  .strict();

export const bulkEditCancelRouter = express.Router();

bulkEditCancelRouter.post(
  "/api/bulk-edit/cancel",
  auth,
  requireShop,
  async (req: express.Request, res: express.Response) => {
    const shop = req.shopDomain;

    if (!shop) {
      return res.status(401).json({ error: "Unauthorized shop session" });
    }

    const parsed = CancelSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid cancel request" });
    }

    const { bulkJobId } = parsed.data;

    await prisma.bulkApplyRequest.updateMany({
      where: {
        shop,
        bulkJobId,
        status: { in: ["QUEUED", "RUNNING", "PARTIAL_FAILED", "FAILED"] },
      },
      data: {
        status: "CANCELLED",
        finishedAt: new Date(),
      },
    });

    await prisma.bulkApplyItem.updateMany({
      where: {
        shop,
        bulkJobId,
        status: { in: ["PENDING", "FAILED"] },
      },
      data: {
        status: "CANCELLED",
        finishedAt: new Date(),
      },
    });

    return res.json({ ok: true });
  }
);
