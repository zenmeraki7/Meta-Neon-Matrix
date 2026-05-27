import { automaticProductRuleCommandService } from "../services/automaticProductRuleCommandService.js";
import { automaticProductRuleQueryService } from "../services/automaticProductRuleQueryService.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

import {
  normalizeAutomaticRuleListQuery,
  normalizeAutomaticRuleRunsQuery,
  normalizeCreateAutomaticProductRuleBody,
  normalizeRuleIdParam,
  normalizeUpdateAutomaticProductRuleBody,
  validateRunAutomaticProductRuleNowCommand,
} from "./automaticProductRuleRequestNormalizers.js";

import {
  validateCreateAutomaticProductRuleCommand,
  validateUpdateAutomaticProductRuleCommand,
} from "./automaticProductRuleCommandNormalizer.js";

import {
  toAutomaticRuleCreateDto,
  toAutomaticRuleDeleteDto,
  toAutomaticRuleDetailDto,
  toAutomaticRuleListDto,
  toAutomaticRuleRunCommandDto,
  toAutomaticRuleRunListDto,
  toAutomaticRuleStateDto,
  toAutomaticRuleUpdateDto,
} from "./automaticProductRuleDtoMapper.js";

const LOG_SOURCE = Object.freeze({
  CREATE: "automaticProductRuleController.create",
  LIST: "automaticProductRuleController.list",
  GET_BY_ID: "automaticProductRuleController.getById",
  UPDATE: "automaticProductRuleController.update",
  PAUSE: "automaticProductRuleController.pause",
  RESUME: "automaticProductRuleController.resume",
  RUN_NOW: "automaticProductRuleController.runNow",
  DELETE: "automaticProductRuleController.delete",
  LIST_RUNS: "automaticProductRuleController.listRuns",
});

const AUTOMATIC_RULES_API_VERSION = "2026-05-automatic-rules-v1";

const DELETE_POLICIES = Object.freeze({
  BLOCK_FUTURE_RUNS: "SOFT_DELETE_BLOCK_FUTURE_RUNS",
  CANCEL_QUEUED: "SOFT_DELETE_AND_CANCEL_QUEUED",
});

const PAUSE_POLICIES = Object.freeze({
  FUTURE_ONLY: "FUTURE_ONLY",
  CANCEL_QUEUED: "CANCEL_QUEUED",
});

const ALLOWED_DELETE_POLICIES = new Set(Object.values(DELETE_POLICIES));
const ALLOWED_PAUSE_POLICIES = new Set(Object.values(PAUSE_POLICIES));

function createPublicControllerError(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function requireShopifySession(res) {
  const session = res.locals.shopify?.session;

  if (!session?.shop) {
    throw createPublicControllerError(
      "UNAUTHENTICATED",
      401,
      "Authentication required.",
    );
  }

  return session;
}

function requireEntitlementContext(res) {
  const entitlement = res.locals.entitlement;

  if (!entitlement) {
    throw createPublicControllerError(
      "ENTITLEMENT_CONTEXT_REQUIRED",
      403,
      "Entitlement context is required.",
    );
  }

  if (entitlement.allowed === false) {
    throw createPublicControllerError(
      "ENTITLEMENT_DENIED",
      403,
      "Automatic product rules are not available for the current shop.",
    );
  }

  return entitlement;
}

function getRequestId(req) {
  return (
    req?.id ||
    req?.headers?.["x-request-id"] ||
    req?.headers?.["x-correlation-id"] ||
    null
  );
}

function buildActorContext(session, req) {
  return {
    actorType: session.onlineAccessInfo
      ? "SHOPIFY_USER"
      : "SHOPIFY_OFFLINE_SESSION",
    shop: session.shop,
    sessionId: session.id ?? null,
    userId: session.onlineAccessInfo?.associated_user?.id ?? null,
    userEmail: session.onlineAccessInfo?.associated_user?.email ?? null,
    requestId: getRequestId(req),
  };
}

function buildSanitizedRequestMeta(req) {
  return {
    method: req?.method || null,
    originalUrl: req?.originalUrl || req?.url || null,
    requestId: getRequestId(req),
    headers: {
      "x-request-id": req?.headers?.["x-request-id"] || null,
      "x-correlation-id": req?.headers?.["x-correlation-id"] || null,
      "user-agent": req?.headers?.["user-agent"] || null,
    },
    params: req?.params || {},
    query: req?.query || {},
    body: req?.body ? { hasBody: true } : { hasBody: false },
  };
}

async function logControllerError({ session, error, req, source }) {
  await logApiError({
    shop: session?.shop,
    err: error,
    request: buildSanitizedRequestMeta(req),
    req: buildSanitizedRequestMeta(req),
    source,
  });
}

function buildSuccessResponse({ code, data }) {
  return {
    success: true,
    code,
    data,
    meta: {
      apiVersion: AUTOMATIC_RULES_API_VERSION,
    },
  };
}

function normalizePauseAutomaticProductRuleBody(body = {}) {
  const pausePolicy = body?.pausePolicy || PAUSE_POLICIES.FUTURE_ONLY;

  if (!ALLOWED_PAUSE_POLICIES.has(pausePolicy)) {
    throw createPublicControllerError(
      "INVALID_PAUSE_POLICY",
      400,
      "Invalid pause policy.",
    );
  }

  return {
    pausePolicy,
  };
}

function normalizeDeleteAutomaticProductRuleBody(body = {}) {
  const deletePolicy = body?.deletePolicy || DELETE_POLICIES.BLOCK_FUTURE_RUNS;

  if (!ALLOWED_DELETE_POLICIES.has(deletePolicy)) {
    throw createPublicControllerError(
      "INVALID_DELETE_POLICY",
      400,
      "Invalid delete policy.",
    );
  }

  return {
    deletePolicy,
    confirmation:
      typeof body?.confirmation === "string" ? body.confirmation.trim() : null,
    confirmationAccepted: body?.confirmationAccepted === true,
  };
}

function assertDeleteConfirmationIfActive(rule, deleteCommand) {
  const status = rule?.statusKey || rule?.status;

  if (status !== "ACTIVE") {
    return;
  }

  const confirmedByPhrase =
    deleteCommand.confirmation === "DELETE AUTOMATIC RULE";

  const confirmedByFlag =
    ALLOWED_DELETE_POLICIES.has(deleteCommand.deletePolicy) &&
    deleteCommand.confirmationAccepted === true;

  if (!confirmedByPhrase && !confirmedByFlag) {
    throw createPublicControllerError(
      "CONFIRMATION_REQUIRED",
      400,
      "Confirmation is required before deleting an active automatic rule.",
    );
  }
}

function buildRunNowCommand(req) {
  return validateRunAutomaticProductRuleNowCommand({
    automaticProductRuleId: req.params?.id,
    idempotencyKey: req.get("Idempotency-Key") || req.body?.idempotencyKey,
    expectedRuleRevision: req.body?.expectedRuleRevision,
    safetyConfirmation: req.body?.safetyConfirmation,
  });
}

export async function createAutomaticProductRuleController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const entitlement = requireEntitlementContext(res);
    const actor = buildActorContext(session, req);

    const command = validateCreateAutomaticProductRuleCommand(
      normalizeCreateAutomaticProductRuleBody(req.body),
    );

    const rule = await automaticProductRuleCommandService.createRule({
      shop: session.shop,
      actor,
      entitlement,
      command,
    });

    return res.status(201).json(
      buildSuccessResponse({
        code: "AUTOMATIC_RULE_CREATED",
        data: toAutomaticRuleCreateDto(rule),
      }),
    );
  } catch (error) {
    await logControllerError({
      session,
      error,
      req,
      source: LOG_SOURCE.CREATE,
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "AUTOMATIC_RULE_ERROR",
    );

    return res.status(statusCode).json(body);
  }
}

export async function listAutomaticProductRulesController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const page = normalizeAutomaticRuleListQuery(req.query);

    const result = await automaticProductRuleQueryService.listRules({
      shop: session.shop,
      page,
    });

    return res.status(200).json(
      buildSuccessResponse({
        code: "AUTOMATIC_RULE_LISTED",
        data: {
          rules: toAutomaticRuleListDto(result.rules),
          pageInfo: result.pageInfo,
        },
      }),
    );
  } catch (error) {
    await logControllerError({
      session,
      error,
      req,
      source: LOG_SOURCE.LIST,
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "AUTOMATIC_RULE_ERROR",
    );

    return res.status(statusCode).json(body);
  }
}

export async function getAutomaticProductRuleByIdController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const ruleId = normalizeRuleIdParam(req.params);

    const rule = await automaticProductRuleQueryService.getRuleDetail({
      shop: session.shop,
      ruleId,
    });

    return res.status(200).json(
      buildSuccessResponse({
        code: "AUTOMATIC_RULE_FETCHED",
        data: toAutomaticRuleDetailDto(rule),
      }),
    );
  } catch (error) {
    await logControllerError({
      session,
      error,
      req,
      source: LOG_SOURCE.GET_BY_ID,
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "AUTOMATIC_RULE_ERROR",
    );

    return res.status(statusCode).json(body);
  }
}

export async function updateAutomaticProductRuleController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const entitlement = requireEntitlementContext(res);
    const actor = buildActorContext(session, req);
    const ruleId = normalizeRuleIdParam(req.params);

    const patchCommand = validateUpdateAutomaticProductRuleCommand(
      normalizeUpdateAutomaticProductRuleBody(req.body),
    );

    const rule = await automaticProductRuleCommandService.updateRule({
      shop: session.shop,
      actor,
      ruleId,
      patchCommand,
      entitlement,
    });

    return res.status(200).json(
      buildSuccessResponse({
        code: "AUTOMATIC_RULE_UPDATED",
        data: toAutomaticRuleUpdateDto(rule),
      }),
    );
  } catch (error) {
    await logControllerError({
      session,
      error,
      req,
      source: LOG_SOURCE.UPDATE,
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "AUTOMATIC_RULE_ERROR",
    );

    return res.status(statusCode).json(body);
  }
}

export async function pauseAutomaticProductRuleController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const actor = buildActorContext(session, req);
    const ruleId = normalizeRuleIdParam(req.params);
    const pauseCommand = normalizePauseAutomaticProductRuleBody(req.body);

    const rule = await automaticProductRuleCommandService.pauseRule({
      shop: session.shop,
      actor,
      ruleId,
      pausePolicy: pauseCommand.pausePolicy,
    });

    return res.status(200).json(
      buildSuccessResponse({
        code: "AUTOMATIC_RULE_PAUSED",
        data: toAutomaticRuleStateDto(rule, {
          ruleId,
          status: "PAUSED",
        }),
      }),
    );
  } catch (error) {
    await logControllerError({
      session,
      error,
      req,
      source: LOG_SOURCE.PAUSE,
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "AUTOMATIC_RULE_ERROR",
    );

    return res.status(statusCode).json(body);
  }
}

export async function resumeAutomaticProductRuleController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const entitlement = requireEntitlementContext(res);
    const actor = buildActorContext(session, req);
    const ruleId = normalizeRuleIdParam(req.params);

    const rule = await automaticProductRuleCommandService.resumeRule({
      shop: session.shop,
      actor,
      ruleId,
      entitlement,
    });

    return res.status(200).json(
      buildSuccessResponse({
        code: "AUTOMATIC_RULE_RESUMED",
        data: toAutomaticRuleStateDto(rule, {
          ruleId,
          status: "ACTIVE",
          nextRunAt: rule?.nextRunAt || null,
        }),
      }),
    );
  } catch (error) {
    await logControllerError({
      session,
      error,
      req,
      source: LOG_SOURCE.RESUME,
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "AUTOMATIC_RULE_ERROR",
    );

    return res.status(statusCode).json(body);
  }
}

export async function runAutomaticProductRuleNowController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const entitlement = requireEntitlementContext(res);
    const actor = buildActorContext(session, req);
    const command = buildRunNowCommand(req);

    const run = await automaticProductRuleCommandService.runRuleNow({
      shop: session.shop,
      actor,
      ruleId: command.automaticProductRuleId,
      idempotencyKey: command.idempotencyKey,
      expectedRuleRevision: command.expectedRuleRevision,
      entitlement,
    });

    return res.status(202).json(
      buildSuccessResponse({
        code: "AUTOMATIC_RULE_RUN_QUEUED",
        data: toAutomaticRuleRunCommandDto(run),
      }),
    );
  } catch (error) {
    await logControllerError({
      session,
      error,
      req,
      source: LOG_SOURCE.RUN_NOW,
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "AUTOMATIC_RULE_ERROR",
    );

    return res.status(statusCode).json(body);
  }
}

export async function deleteAutomaticProductRuleController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const actor = buildActorContext(session, req);
    const ruleId = normalizeRuleIdParam(req.params);
    const deleteCommand = normalizeDeleteAutomaticProductRuleBody(req.body);

    const rule = await automaticProductRuleQueryService.getRuleDetail({
      shop: session.shop,
      ruleId,
    });

    assertDeleteConfirmationIfActive(rule, deleteCommand);

    const result = await automaticProductRuleCommandService.deleteRule({
      shop: session.shop,
      actor,
      ruleId,
      deletePolicy: deleteCommand.deletePolicy,
    });

    return res.status(200).json(
      buildSuccessResponse({
        code: "AUTOMATIC_RULE_DELETED",
        data: toAutomaticRuleDeleteDto(result),
      }),
    );
  } catch (error) {
    await logControllerError({
      session,
      error,
      req,
      source: LOG_SOURCE.DELETE,
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "AUTOMATIC_RULE_ERROR",
    );

    return res.status(statusCode).json(body);
  }
}

export async function listAutomaticProductRuleRunsController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const ruleId = normalizeRuleIdParam(req.params);
    const page = normalizeAutomaticRuleRunsQuery(req.query);

    const result = await automaticProductRuleQueryService.listRuleRuns({
      shop: session.shop,
      ruleId,
      page,
    });

    return res.status(200).json(
      buildSuccessResponse({
        code: "AUTOMATIC_RULE_RUNS_LISTED",
        data: {
          runs: toAutomaticRuleRunListDto(result.runs),
          pageInfo: result.pageInfo,
        },
      }),
    );
  } catch (error) {
    await logControllerError({
      session,
      error,
      req,
      source: LOG_SOURCE.LIST_RUNS,
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "AUTOMATIC_RULE_ERROR",
    );

    return res.status(statusCode).json(body);
  }
}
