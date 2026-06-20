import express from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/database.js";
import { applyQueue } from "../queues/applyQueue.js";
import auth from "../middleware/requireSession.js";
import { requireShop } from "../middleware/requireShop.js";

const ProductGid = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/);

const ApplySchema = z
  .object({
    intent: z.literal("apply_bulk_edit"),
    bulkJobId: z.string().min(1).max(128),
    productIds: z
      .array(ProductGid)
      .min(1)
      .max(100)
      .transform((ids) => [...new Set(ids)]),
    idempotencyKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();

export const bulkEditApplyRouter = express.Router();

bulkEditApplyRouter.post(
  "/api/bulk-edit/apply",
  auth,
  requireShop,
  async (req: express.Request, res: express.Response) => {
    const shop = req.shopDomain;

    if (!shop) {
      return res.status(401).json({ error: "Unauthorized shop session" });
    }

    const parsed = ApplySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid apply request" });
    }

    const { bulkJobId, productIds, idempotencyKey } = parsed.data;

    const result = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const existing = await tx.bulkApplyRequest.findUnique({
          where: {
            shop_bulkJobId_idempotencyKey: {
              shop,
              bulkJobId,
              idempotencyKey,
            },
          },
        });

        if (existing) {
          return { applyRequest: existing, reused: true };
        }

        const draft = await tx.bulkEditDraft.findFirst({
          where: {
            id: bulkJobId,
            shop,
            status: "DRAFT",
          },
        });

        if (!draft) {
          throw new Error("DRAFT_NOT_FOUND");
        }

        const applyRequest = await tx.bulkApplyRequest.create({
          data: {
            shop,
            bulkJobId,
            idempotencyKey,
            status: "QUEUED",
            totalCount: productIds.length,
          },
        });

        await tx.bulkApplyItem.createMany({
          data: productIds.map((productId) => ({
            shop,
            bulkJobId,
            productId,
            status: "PENDING",
          })),
          skipDuplicates: true,
        });

        return { applyRequest, reused: false };
      }
    );

    await applyQueue.add(
      "apply-bulk-edit",
      {
        shop,
        bulkJobId,
        applyRequestId: result.applyRequest.id,
        idempotencyKey,
      },
      {
        jobId: `apply:${shop}:${bulkJobId}:${idempotencyKey}`,
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 2_000,
        },
      }
    );

    return res.json({
      ok: true,
      applyRequestId: result.applyRequest.id,
      reused: result.reused,
    });
  }
);
