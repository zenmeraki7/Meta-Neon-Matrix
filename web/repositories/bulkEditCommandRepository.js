import { prisma } from "../config/database.js";

export async function findPreviewContractRecord(previewContractId, shop) {
  return prisma.filterTrack.findFirst({
    where: {
      id: String(previewContractId),
      shop,
      type: "preview",
    },
  });
}
