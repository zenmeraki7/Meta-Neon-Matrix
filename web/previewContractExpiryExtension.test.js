import test from "node:test";
import assert from "node:assert/strict";
import {
  extendPreviewContractExpiry,
  createManualEditHistoryWithImmutableCommand,
} from "./repositories/bulkEditCommandRepository.js";

test("Two simultaneous expiry extensions with the same revision: exactly one succeeds", async () => {
  let dbRevision = 1;

  const mockTx = {
    filterTrack: {
      updateMany: async ({ where, data }) => {
        if (
          where.id === "preview-1" &&
          where.shop === "test-shop.myshopify.com" &&
          where.revision === dbRevision
        ) {
          dbRevision += data.revision.increment;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };

  const now = new Date("2026-08-02T10:00:00Z");
  const futureDate = new Date("2026-08-02T11:00:00Z");

  // First call succeeds
  const res1 = await extendPreviewContractExpiry({
    previewContractId: "preview-1",
    shop: "test-shop.myshopify.com",
    expectedRevision: 1,
    expiresAt: futureDate,
    now,
    tx: mockTx,
  });

  assert.equal(res1.revision, 2);

  // Second call with same revision 1 fails with extension conflict
  await assert.rejects(
    async () => {
      await extendPreviewContractExpiry({
        previewContractId: "preview-1",
        shop: "test-shop.myshopify.com",
        expectedRevision: 1,
        expiresAt: futureDate,
        now,
        tx: mockTx,
      });
    },
    (err) => {
      assert.equal(err.code, "PREVIEW_EXPIRY_EXTENSION_CONFLICT");
      return true;
    },
  );
});

test("Expired preview cannot be revived", async () => {
  const now = new Date("2026-08-02T10:00:00Z");
  const pastExpiresAt = new Date("2026-08-02T09:00:00Z");

  const mockTx = {
    filterTrack: {
      updateMany: async ({ where }) => {
        // Query has expiresAt: { gt: now }. For an expired preview, expiresAt <= now, so 0 rows match.
        if (pastExpiresAt <= where.expiresAt.gt) {
          return { count: 0 };
        }
        return { count: 1 };
      },
    },
  };

  const futureDate = new Date("2026-08-02T11:00:00Z");

  await assert.rejects(
    async () => {
      await extendPreviewContractExpiry({
        previewContractId: "expired-preview",
        shop: "test-shop.myshopify.com",
        expectedRevision: 1,
        expiresAt: futureDate,
        now,
        tx: mockTx,
      });
    },
    (err) => {
      assert.equal(err.code, "PREVIEW_EXPIRY_EXTENSION_CONFLICT");
      return true;
    },
  );
});

test("Approved or executed preview cannot be extended", async () => {
  const now = new Date("2026-08-02T10:00:00Z");

  const mockTx = {
    filterTrack: {
      updateMany: async ({ where }) => {
        // Mock DB record has status: "APPROVED" or executionId: "exec-123"
        // Query requires status: { in: ["DRAFT", "READY_FOR_REVIEW"] } and executionId: null
        const allowedStatuses = where.status?.in || [];
        const statusMatch = allowedStatuses.includes("APPROVED");
        const executionMatch = where.executionId === null;

        if (!statusMatch || !executionMatch) {
          return { count: 0 };
        }
        return { count: 1 };
      },
    },
  };

  const futureDate = new Date("2026-08-02T11:00:00Z");

  await assert.rejects(
    async () => {
      await extendPreviewContractExpiry({
        previewContractId: "approved-preview",
        shop: "test-shop.myshopify.com",
        expectedRevision: 1,
        expiresAt: futureDate,
        now,
        tx: mockTx,
      });
    },
    (err) => {
      assert.equal(err.code, "PREVIEW_EXPIRY_EXTENSION_CONFLICT");
      return true;
    },
  );
});

test("Cross-shop extension updates zero rows", async () => {
  const now = new Date("2026-08-02T10:00:00Z");

  const mockTx = {
    filterTrack: {
      updateMany: async ({ where }) => {
        if (where.shop === "attacker-shop.myshopify.com") {
          return { count: 0 };
        }
        return { count: 1 };
      },
    },
  };

  const futureDate = new Date("2026-08-02T11:00:00Z");

  await assert.rejects(
    async () => {
      await extendPreviewContractExpiry({
        previewContractId: "target-preview",
        shop: "attacker-shop.myshopify.com",
        expectedRevision: 1,
        expiresAt: futureDate,
        now,
        tx: mockTx,
      });
    },
    (err) => {
      assert.equal(err.code, "PREVIEW_EXPIRY_EXTENSION_CONFLICT");
      return true;
    },
  );
});

test("Earlier expiry cannot replace a later expiry unless explicitly permitted", async () => {
  const now = new Date("2026-08-02T10:00:00Z");
  const earlierExpiry = new Date("2026-08-02T09:30:00Z"); // <= now

  const mockTx = {
    filterTrack: {
      updateMany: async () => ({ count: 1 }),
    },
  };

  await assert.rejects(
    async () => {
      await extendPreviewContractExpiry({
        previewContractId: "preview-1",
        shop: "test-shop.myshopify.com",
        expectedRevision: 1,
        expiresAt: earlierExpiry,
        now,
        tx: mockTx,
      });
    },
    (err) => {
      assert.equal(err.code, "INVALID_PREVIEW_EXPIRY");
      return true;
    },
  );
});
