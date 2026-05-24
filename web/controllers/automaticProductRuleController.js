import {
  createAutomaticProductRule,
  deleteAutomaticProductRule,
  getAutomaticProductRuleById,
  listAutomaticProductRuleRuns,
  listAutomaticProductRules,
  pauseAutomaticProductRule,
  resumeAutomaticProductRule,
  runAutomaticProductRuleNow,
  updateAutomaticProductRule,
} from "../services/automaticProductRuleService.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

function getSessionOrThrow(res) {
  const session = res.locals.shopify?.session;
  if (!session?.shop) {
    const error = new Error("UNAUTHENTICATED");
    error.code = "UNAUTHENTICATED";
    throw error;
  }
  return session;
}

function getUserFromSession(session) {
  return session?.id || session?.shop || null;
}

export async function createAutomaticProductRuleController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await createAutomaticProductRule({
      shop: session.shop,
      body: req.body,
      subscription: req.subscription,
      createdBy: getUserFromSession(session),
    });

    return res.status(201).json({ success: true, data, message: "Automatic rule created successfully" });
  } catch (error) {
    await logApiError({ shop: session?.shop, err: error, req, source: "automaticProductRuleController.create" });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function listAutomaticProductRulesController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await listAutomaticProductRules({ shop: session.shop });
    return res.status(200).json({ success: true, data, message: "Automatic rules fetched successfully" });
  } catch (error) {
    await logApiError({ shop: session?.shop, err: error, req, source: "automaticProductRuleController.list" });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
}

export async function getAutomaticProductRuleByIdController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await getAutomaticProductRuleById({
      shop: session.shop,
      automaticProductRuleId: req.params.id,
    });

    return res.status(200).json({ success: true, data, message: "Automatic rule fetched successfully" });
  } catch (error) {
    await logApiError({ shop: session?.shop, err: error, req, source: "automaticProductRuleController.getById" });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "NOT_FOUND",
    );
    return res.status(statusCode).json(body);
  }
}

export async function updateAutomaticProductRuleController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await updateAutomaticProductRule({
      shop: session.shop,
      automaticProductRuleId: req.params.id,
      body: req.body,
      subscription: req.subscription,
      updatedBy: getUserFromSession(session),
    });

    return res.status(200).json({ success: true, data, message: "Automatic rule updated successfully" });
  } catch (error) {
    await logApiError({ shop: session?.shop, err: error, req, source: "automaticProductRuleController.update" });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function pauseAutomaticProductRuleController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await pauseAutomaticProductRule({
      shop: session.shop,
      automaticProductRuleId: req.params.id,
    });

    return res.status(200).json({ success: true, data, message: "Automatic rule paused successfully" });
  } catch (error) {
    await logApiError({ shop: session?.shop, err: error, req, source: "automaticProductRuleController.pause" });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function resumeAutomaticProductRuleController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await resumeAutomaticProductRule({
      shop: session.shop,
      automaticProductRuleId: req.params.id,
      subscription: req.subscription,
      updatedBy: getUserFromSession(session),
    });

    return res.status(200).json({ success: true, data, message: "Automatic rule resumed successfully" });
  } catch (error) {
    await logApiError({ shop: session?.shop, err: error, req, source: "automaticProductRuleController.resume" });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function runAutomaticProductRuleNowController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await runAutomaticProductRuleNow({
      shop: session.shop,
      automaticProductRuleId: req.params.id,
      subscription: req.subscription,
    });

    return res.status(202).json({ success: true, data, message: "Automatic rule run queued successfully" });
  } catch (error) {
    await logApiError({ shop: session?.shop, err: error, req, source: "automaticProductRuleController.runNow" });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function deleteAutomaticProductRuleController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await deleteAutomaticProductRule({
      shop: session.shop,
      automaticProductRuleId: req.params.id,
    });

    return res.status(200).json({ success: true, data, message: "Automatic rule deleted successfully" });
  } catch (error) {
    await logApiError({ shop: session?.shop, err: error, req, source: "automaticProductRuleController.delete" });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function listAutomaticProductRuleRunsController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await listAutomaticProductRuleRuns({
      shop: session.shop,
      automaticProductRuleId: req.params.id,
    });

    return res.status(200).json({ success: true, data, message: "Automatic rule runs fetched successfully" });
  } catch (error) {
    await logApiError({ shop: session?.shop, err: error, req, source: "automaticProductRuleController.listRuns" });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "NOT_FOUND",
    );
    return res.status(statusCode).json(body);
  }
}
