import { jsonResponse } from "../lib/serialise.js";
import {
  createBulkEditSession,
  discardSessionPendingChanges,
  getSessionById,
  getSessionColumnErrors,
  getSessionColumnVariantErrors,
  getSessionPreviewById,
} from "../useCases/sessionQueryUseCases.js";

function toStatusCode(error, fallback = 500) {
  const code = Number(error?.statusCode || fallback);
  return Number.isFinite(code) ? code : fallback;
}

export async function createSessionController(req, res) {
  try {
    const session = await createBulkEditSession({
      shop: res.locals.shop,
      filterParams: req.body?.filterParams,
      variantCount: req.body?.variantCount,
    });
    jsonResponse(res, { session }, 201);
  } catch (error) {
    const body = { error: error?.message || "Failed to create session" };
    if (Array.isArray(error?.fields) && error.fields.length) body.fields = error.fields;
    jsonResponse(res, body, toStatusCode(error));
  }
}

export async function getSessionController(req, res) {
  try {
    const session = await getSessionById({
      shop: res.locals.shop,
      sessionId: req.params.id,
    });
    if (!session) {
      jsonResponse(res, { error: "Session not found" }, 404);
      return;
    }
    jsonResponse(res, { session });
  } catch (error) {
    jsonResponse(res, { error: error?.message || "Failed to load session" }, toStatusCode(error));
  }
}

export async function getSessionPreviewController(req, res) {
  try {
    const preview = await getSessionPreviewById({
      shop: res.locals.shop,
      sessionId: req.params.id,
    });
    if (!preview) {
      jsonResponse(res, { error: "Session not found" }, 404);
      return;
    }
    jsonResponse(res, preview);
  } catch (error) {
    jsonResponse(res, { error: error?.message || "Failed to load preview" }, toStatusCode(error));
  }
}

export async function getSessionColumnErrorsController(req, res) {
  try {
    const columns = await getSessionColumnErrors({
      shop: res.locals.shop,
      sessionId: req.params.id,
    });
    if (!columns) {
      jsonResponse(res, { error: "Session not found" }, 404);
      return;
    }
    jsonResponse(res, { columns });
  } catch (error) {
    jsonResponse(res, { error: error?.message || "Failed to load column errors" }, toStatusCode(error));
  }
}

export async function getSessionColumnVariantErrorsController(req, res) {
  try {
    const result = await getSessionColumnVariantErrors({
      shop: res.locals.shop,
      sessionId: req.params.id,
      namespace: req.query?.namespace,
      key: req.query?.key,
    });
    jsonResponse(res, result);
  } catch (error) {
    const body = { error: error?.message || "Failed to load error variants" };
    if (error?.code) body.code = error.code;
    jsonResponse(res, body, toStatusCode(error));
  }
}

export async function discardSessionController(req, res) {
  try {
    const result = await discardSessionPendingChanges({
      shop: res.locals.shop,
      sessionId: req.params.id,
    });
    jsonResponse(res, result);
  } catch (error) {
    const body = { error: error?.message || "Failed to discard pending changes" };
    if (error?.code) body.code = error.code;
    jsonResponse(res, body, toStatusCode(error));
  }
}
