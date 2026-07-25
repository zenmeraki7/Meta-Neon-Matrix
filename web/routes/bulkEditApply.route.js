import express from "express";
import { z } from "zod";
import { prisma } from "../config/database.js";
import { applyQueue } from "../queues/applyQueue.js";
import auth from "../middleware/requireSession.js";
import { requireShop } from "../middleware/requireShop.js";

const ProductGid = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/);

const ApplySchema = z
  .object({
    intent: z.literal("apply_bulk_edit"),
    bulkApplyJobId: z.string().min(1).max(128),
    productIds: z
      .array(ProductGid)
      .min(1)
      .max(100)
      .transform((ids) => [...new Set(ids)]),
    requestIdempotencyKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  })
  .strict()
  .refine((body) => !body.idempotencyKey || body.idempotencyKey === body.requestIdempotencyKey, {
    message: "Conflicting request idempotency keys",
  });

export const bulkEditApplyRouter = express.Router();

bulkEditApplyRouter.post(
  "/api/bulk-edit/apply",
  auth,
  requireShop,
  async (req, res) => {
    const shop = req.shopDomain;
    const parsed = ApplySchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid apply request" });
    }

    const { bulkApplyJobId, productIds, requestIdempotencyKey } = parsed.data;
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.bulkApplyRequest.findUnique({
        where: {
          shop_bulkApplyJobId_requestIdempotencyKey: { shop, bulkApplyJobId, requestIdempotencyKey },
        },
      });

      if (existing) return { applyRequest: existing, reused: true };

      const draft = await tx.bulkEditDraft.findFirst({
        where: { id: bulkApplyJobId, shop, status: "DRAFT" },
      });

      if (!draft) throw new Error("DRAFT_NOT_FOUND");

      const applyRequest = await tx.bulkApplyRequest.create({
        data: {
          shop,
          bulkApplyJobId,
          requestIdempotencyKey,
          status: "QUEUED",
          eligibleItemCount: productIds.length,
          pendingItemCount: productIds.length,
        },
      });

      await tx.bulkApplyItem.createMany({
        data: productIds.map((productId) => ({
          shop,
          requestId: applyRequest.id,
          bulkApplyJobId,
          productId,
          status: "PENDING",
        })),
        skipDuplicates: true,
      });

      return { applyRequest, reused: false };
    });

    await applyQueue.add(
      "apply-bulk-edit",
      { shop, bulkApplyJobId, applyRequestId: result.applyRequest.id, requestIdempotencyKey },
      {
        jobId: `apply:${shop}:${bulkApplyJobId}:${requestIdempotencyKey}`,
        attempts: 5,
        backoff: { type: "exponential", delay: 2_000 },
      },
    );

    return res.json({
      ok: true,
      applyRequestId: result.applyRequest.id,
      reused: result.reused,
    });
  },
);
