import {
  getRequiredIdempotencyKey,
} from "../http/idempotencyKey.js";
import { requireShopifySession } from "../http/shopifySession.js";
import { buildActorFromSession } from "../http/actorContext.js";
import { setPrivateNoStore } from "../http/cacheHeaders.js";

import {
  buildCreateProductExportCommand,
  buildDownloadProductExportCommand,
  buildCancelExportCommand,
  buildPauseExportCommand,
  buildResumeExportCommand,
  buildListProductExportFieldsCommand,
} from "../normalizers/productExportCommandNormalizer.js";

import {
  toExportJobQueuedResponseDto,
  toExportCancellationResponseDto,
  toExportPauseResponseDto,
  toExportResumeResponseDto,
  toProductExportFieldListDto,
  toExportDownloadErrorDto,
} from "../dtos/productExportDto.js";

import {
  productExportUseCases,
  productExportLifecycleUseCases,
} from "../useCases/productExportUseCases.js";

import {
  ExportDownloadError,
  logExportDownloadFailure,
  streamExportCsvDownload,
} from "../services/productExport/exportDownloadService.js";

const CONTROLLER_SOURCE = Object.freeze({
  CREATE: "productExportController.createProductExport",
  LIST_FIELDS: "productExportController.getProductExportFields",
  DOWNLOAD:
    "productExportController.handleDownloadExportProductsData",
  CANCEL: "productExportController.cancelExportOperation",
  PAUSE: "productExportController.pauseExportOperation",
  RESUME:
    "productExportController.resumePausedExportOperation",
});

function assertFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }

  return value;
}

function assertUseCaseGroup(value, methods, name) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${name} is required`);
  }

  for (const method of methods) {
    assertFunction(value[method], `${name}.${method}`);
  }

  return value;
}

function buildContext({
  session,
  shop,
}) {
  return Object.freeze({
    shop,
    actor: buildActorFromSession(session, shop),
  });
}

function buildMutationHeaders(req) {
  return Object.freeze({
    idempotencyKey: getRequiredIdempotencyKey(req),
  });
}

function safelyLogDownloadFailure(
  logFailure,
  error,
  {
    exportJobId = null,
    shop = null,
    requestId = null,
    source,
  },
) {
  Promise.resolve()
    .then(() =>
      logFailure(error, {
        exportJobId,
        shop,
        requestId,
        source,
      }),
    )
    .catch(() => {
      // Logging failure must not alter the download response.
    });
}

function isConnectionClosed(req, res) {
  return Boolean(
    req?.aborted ||
    req?.destroyed ||
    res?.destroyed ||
    res?.closed,
  );
}

function sendDownloadError(res, error) {
  const response = toExportDownloadErrorDto(error);

  if (res.headersSent || res.destroyed) {
    return undefined;
  }

  return res
    .status(response.statusCode)
    .json(response.body);
}

export function createProductExportController({
  exportUseCases,
  exportLifecycleUseCases,
  streamDownload,
  logDownloadFailure,
}) {
  const useCases = assertUseCaseGroup(
    exportUseCases,
    ["create", "listFields"],
    "exportUseCases",
  );

  const lifecycleUseCases = assertUseCaseGroup(
    exportLifecycleUseCases,
    ["cancel", "pause", "resume"],
    "exportLifecycleUseCases",
  );

  const streamExportDownload = assertFunction(
    streamDownload,
    "streamDownload",
  );

  const logExportFailure = assertFunction(
    logDownloadFailure,
    "logDownloadFailure",
  );

  async function createProductExport(
    req,
    res,
    next,
  ) {
    try {
      setPrivateNoStore(res);

      const { session, shop } =
        requireShopifySession(
          res,
          "UNAUTHENTICATED",
        );

      const command =
        buildCreateProductExportCommand({
          body: req.body ?? {},
          headers: buildMutationHeaders(req),
          context: buildContext({
            session,
            shop,
          }),
        });

      const result = await useCases.create(command);

      return res
        .status(202)
        .json(
          toExportJobQueuedResponseDto(result),
        );
    } catch (error) {
      return next(error);
    }
  }

  async function getProductExportFields(
    req,
    res,
    next,
  ) {
    try {
      setPrivateNoStore(res);

      const { session, shop } =
        requireShopifySession(
          res,
          "UNAUTHENTICATED",
        );

      const command =
        buildListProductExportFieldsCommand({
          query: req.query ?? {},
          context: buildContext({
            session,
            shop,
          }),
        });

      const result =
        await useCases.listFields(command);

      return res
        .status(200)
        .json(
          toProductExportFieldListDto(result),
        );
    } catch (error) {
      return next(error);
    }
  }

  async function handleDownloadExportProductsData(
    req,
    res,
    next,
  ) {
    let shop = null;
    let exportJobId = null;

    try {
      setPrivateNoStore(res);

      const authenticated =
        requireShopifySession(
          res,
          "UNAUTHENTICATED",
        );

      shop = authenticated.shop;

      const command =
        buildDownloadProductExportCommand({
          params: req.params ?? {},
          context: buildContext({
            session: authenticated.session,
            shop,
          }),
        });

      exportJobId = command.exportJobId;

      await streamExportDownload({
        command,
        req,
        res,
      });

      return undefined;
    } catch (error) {
      const requestId =
        res.locals?.requestId ?? null;

      if (error instanceof ExportDownloadError) {
        safelyLogDownloadFailure(
          logExportFailure,
          error,
          {
            exportJobId,
            shop,
            requestId,
            source: CONTROLLER_SOURCE.DOWNLOAD,
          },
        );

        if (
          error.code ===
          "EXPORT_DOWNLOAD_ABORTED" ||
          isConnectionClosed(req, res) ||
          res.headersSent
        ) {
          return undefined;
        }

        return sendDownloadError(res, error);
      }

      safelyLogDownloadFailure(
        logExportFailure,
        error,
        {
          exportJobId,
          shop,
          requestId,
          source: CONTROLLER_SOURCE.DOWNLOAD,
        },
      );

      if (
        isConnectionClosed(req, res) ||
        res.headersSent
      ) {
        return undefined;
      }

      return next(error);
    }
  }

  async function cancelExportOperation(
    req,
    res,
    next,
  ) {
    try {
      setPrivateNoStore(res);

      const { session, shop } =
        requireShopifySession(
          res,
          "UNAUTHENTICATED",
        );

      const command =
        buildCancelExportCommand({
          params: req.params ?? {},
          body: req.body ?? {},
          headers: buildMutationHeaders(req),
          context: buildContext({
            session,
            shop,
          }),
        });

      const result =
        await lifecycleUseCases.cancel(command);

      return res
        .status(200)
        .json(
          toExportCancellationResponseDto(
            result,
          ),
        );
    } catch (error) {
      return next(error);
    }
  }

  async function pauseExportOperation(
    req,
    res,
    next,
  ) {
    try {
      setPrivateNoStore(res);

      const { session, shop } =
        requireShopifySession(
          res,
          "UNAUTHENTICATED",
        );

      const command =
        buildPauseExportCommand({
          params: req.params ?? {},
          headers: buildMutationHeaders(req),
          context: buildContext({
            session,
            shop,
          }),
        });

      const result =
        await lifecycleUseCases.pause(command);

      return res
        .status(200)
        .json(
          toExportPauseResponseDto(result),
        );
    } catch (error) {
      return next(error);
    }
  }

  async function resumePausedExportOperation(
    req,
    res,
    next,
  ) {
    try {
      setPrivateNoStore(res);

      const { session, shop } =
        requireShopifySession(
          res,
          "UNAUTHENTICATED",
        );

      const command =
        buildResumeExportCommand({
          params: req.params ?? {},
          headers: buildMutationHeaders(req),
          context: buildContext({
            session,
            shop,
          }),
        });

      const result =
        await lifecycleUseCases.resume(command);

      return res
        .status(200)
        .json(
          toExportResumeResponseDto(result),
        );
    } catch (error) {
      return next(error);
    }
  }

  return Object.freeze({
    createProductExport,
    getProductExportFields,
    handleDownloadExportProductsData,
    cancelExportOperation,
    pauseExportOperation,
    resumePausedExportOperation,
  });
}

const productExportController =
  createProductExportController({
    exportUseCases: productExportUseCases,
    exportLifecycleUseCases:
      productExportLifecycleUseCases,
    streamDownload: streamExportCsvDownload,
    logDownloadFailure:
      logExportDownloadFailure,
  });

export const {
  createProductExport,
  getProductExportFields,
  handleDownloadExportProductsData,
  cancelExportOperation,
  pauseExportOperation,
  resumePausedExportOperation,
} = productExportController;