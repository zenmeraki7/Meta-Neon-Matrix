// web/useCases/historyUseCases.js

import { ProductExportService } from "../services/productService/productExportService.js";
import { EditHistoryService } from "../services/historyService/historyService.js";
import {
  getImportHistoryDetail,
  listImportHistories,
} from "../services/historyService/importHistoryQueryService.js";
import { NotFoundError } from "../utils/errorUtils.js";

const EMPTY_ACTIVE_PLAN = Object.freeze({});

function buildUseCaseError(message, code = "VALIDATION_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw buildUseCaseError("Invalid history command", "VALIDATION_ERROR");
  }

  if (!command.shop || typeof command.shop !== "string") {
    throw buildUseCaseError("Authentication required", "UNAUTHENTICATED");
  }

  return command;
}

function assertRequiredString(value, fieldName) {
  if (!value || typeof value !== "string") {
    throw buildUseCaseError(`${fieldName} is required`, "VALIDATION_ERROR");
  }

  return value;
}

function assertDetailCommand(command) {
  command = assertCommand(command);
  assertRequiredString(command.id, "id");
  return command;
}

function requireResult(result, message) {
  if (!result) {
    throw new NotFoundError(message);
  }

  return result;
}

function buildServiceContext(command) {
  return Object.freeze({
    shop: command.shop,
    actor: command.actor || null,
    entitlement: command.entitlement || null,
    subscription: command.subscription || null,
    activePlan: command.activePlan || EMPTY_ACTIVE_PLAN,
  });
}

function createExportService(command) {
  return new ProductExportService(buildServiceContext(command));
}

function createEditHistoryService(command) {
  return new EditHistoryService(buildServiceContext(command));
}

export const historyUseCases = Object.freeze({
  exports: Object.freeze({
    async list(command) {
      command = assertCommand(command);

      const service = createExportService(command);

      return service.getAllExportHistories({
        shop: command.shop,
        lang: command.lang,
        type: command.type,
        cursor: command.cursor,
        limit: command.limit,
      });
    },

    async detail(command) {
      command = assertDetailCommand(command);

      const service = createExportService(command);

      const result = await service.getExportHistoryDetails({
        shop: command.shop,
        id: command.id,
      });

      return requireResult(result, "Export history record not found");
    },
  }),

  edits: Object.freeze({
    async list(command) {
      command = assertCommand(command);

      const service = createEditHistoryService(command);

      return service.getEditHistories({
        shop: command.shop,
        type: command.type,
        search: command.search,
        cursor: command.cursor,
        limit: command.limit,
        lang: command.lang,
      });
    },

    async detail(command) {
      command = assertDetailCommand(command);

      const service = createEditHistoryService(command);

      const result = await service.getHistoryDetails({
        shop: command.shop,
        id: command.id,
        lang: command.lang,
      });

      return requireResult(result, "Edit history record not found");
    },

    async summary(command) {
      command = assertDetailCommand(command);

      const service = createEditHistoryService(command);

      const result = await service.getHistorySummary({
        shop: command.shop,
        id: command.id,
        lang: command.lang,
      });

      return requireResult(result, "Edit history summary not found");
    },

    async changes(command) {
      command = assertDetailCommand(command);

      const service = createEditHistoryService(command);

      const result = await service.getHistoryEditChanges({
        shop: command.shop,
        id: command.id,
        cursor: command.cursor,
        limit: command.limit,
      });

      return requireResult(result, "Edit history changes not found");
    },
  }),

  imports: Object.freeze({
    async list(command) {
      command = assertCommand(command);

      return listImportHistories({
        shop: command.shop,
        cursor: command.cursor,
        limit: command.limit,
      });
    },

    async detail(command) {
      command = assertDetailCommand(command);

      const result = await getImportHistoryDetail({
        shop: command.shop,
        id: command.id,
      });

      return requireResult(result, "Import history record not found");
    },
  }),
});
