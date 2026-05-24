import crypto from "crypto";
import { prisma } from "../config/database.js";

const FILTER_COMBINATION_TYPE = "filter_combination";

function toRecordPayload(input = {}) {
  return {
    customTitle: input.customTitle || null,
    title: input.title || null,
    description: input.description || null,
  };
}

function fromFilterTrack(row) {
  return {
    id: row.id,
    shop: row.shop,
    title: row?.value?.title || row.field || "",
    description: row?.value?.description || row.searchKey || "",
    filters: Array.isArray(row.filterParams) ? row.filterParams : [],
    customTitle: row?.value?.customTitle || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class FilterCombinationRepository {
  async countByShop(shop) {
    return prisma.filterTrack.count({
      where: {
        shop,
        type: FILTER_COMBINATION_TYPE,
      },
    });
  }

  async create({ shop, filters, customTitle, title, description }) {
    const id = crypto.randomUUID();
    const row = await prisma.filterTrack.create({
      data: {
        id,
        shop,
        type: FILTER_COMBINATION_TYPE,
        filterParams: Array.isArray(filters) ? filters : [],
        field: title || "",
        searchKey: description || "",
        value: toRecordPayload({ customTitle, title, description }),
      },
    });
    return fromFilterTrack(row);
  }

  async listByShop(shop, limit = 10) {
    const rows = await prisma.filterTrack.findMany({
      where: {
        shop,
        type: FILTER_COMBINATION_TYPE,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(fromFilterTrack);
  }

  async updateById({ id, shop, filters }) {
    await prisma.filterTrack.updateMany({
      where: { id, shop, type: FILTER_COMBINATION_TYPE },
      data: {
        filterParams: Array.isArray(filters) ? filters : [],
      },
    });
    const row = await prisma.filterTrack.findFirst({
      where: { id, shop, type: FILTER_COMBINATION_TYPE },
    });
    return row ? fromFilterTrack(row) : null;
  }

  async deleteById({ id, shop }) {
    const existing = await prisma.filterTrack.findFirst({
      where: { id, shop, type: FILTER_COMBINATION_TYPE },
    });
    if (!existing) return null;
    await prisma.filterTrack.delete({ where: { id: existing.id } });
    return fromFilterTrack(existing);
  }
}

export default FilterCombinationRepository;
