import type { FastifyRequest, FastifyReply } from 'fastify';
import { tokenRouter } from '../../services/tokenRouter.js';
import { reportProxyAllFailed } from '../../services/alertService.js';
import {
  buildClaudeCountTokensUpstreamRequest,
  resolveUpstreamEndpointCandidates,
} from '../../services/upstreamEndpointRuntime.js';
import { getUpstreamEndpointRuntimeStateSnapshot } from '../../services/upstreamEndpointRuntimeMemory.js';
import {
  ensureModelAllowedForDownstreamKey,
  getDownstreamRoutingPolicy,
  recordDownstreamCostUsage,
} from '../../services/downstreamPolicyRequest.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { getOauthInfoFromAccount } from '../../services/oauth/oauthAccount.js';
import { readRuntimeResponseText } from '../executors/types.js';
import { detectDownstreamClientContext } from '../downstreamClientContext.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import { createRequestTraceId } from '../../services/requestTraceId.js';
import {
  acquireSurfaceChannelLease,
  bindSurfaceStickyChannel,
  buildSurfaceChannelBusyMessage,
  buildSurfaceStickySessionKey,
  clearSurfaceStickyChannel,
  createSurfaceFailureToolkit,
  createSurfaceDispatchRequest,
  getSurfaceStickyPreferredChannelId,
  selectSurfaceChannelForAttempt,
  trySurfaceOauthRefreshRecovery,
} from './sharedSurface.js';
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import {
  buildSurfaceProxyDebugResponseHeaders,
  safeFinalizeSurfaceProxyDebugTrace,
  safeInsertSurfaceProxyDebugAttempt,
  safeUpdateSurfaceProxyDebugCandidates,
  safeUpdateSurfaceProxyDebugSelection,
  startSurfaceProxyDebugTrace,
} from '../../services/proxyDebugTraceRuntime.js';
import {
  buildForcedChannelUnavailableMessage,
  canRetryChannelSelection,
  getTesterForcedChannelId,
  resolveProxyFailoverLimits,
} from '../channelSelection.js';
import {
  asTrimmedString,
  finalizeRetryAsExecutionFailure,
  finalizeRetryAsUpstreamFailure,
  isRecord,
} from './chatSurfaceHelpers.js';

export async function handleClaudeCountTokensSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const rawBody = isRecord(request.body) ? { ...request.body } : null;
  if (!rawBody) {
    return reply.code(400).send({
      error: {
        message: 'Request body must be a JSON object',
        type: 'invalid_request_error',
      },
    });
  }

  const requestedModel = asTrimmedString(rawBody.model);
  if (!requestedModel) {
    return reply.code(400).send({
      error: {
        message: 'model is required',
        type: 'invalid_request_error',
      },
    });
  }

  if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
  const downstreamPath = '/v1/messages/count_tokens';
  const clientContext = detectDownstreamClientContext({
    downstreamPath,
    headers: request.headers as Record<string, unknown>,
    body: rawBody,
  });
  const downstreamPolicy = getDownstreamRoutingPolicy(request);
  const forcedChannelId = getTesterForcedChannelId({
    headers: request.headers as Record<string, unknown>,
    clientIp: request.ip,
  });
  const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
  let maxRetries = getProxyMaxChannelRetries();
  let failoverBudgetMs = 0;
  try {
    const eligibleCount = await tokenRouter.countEligibleChannels(requestedModel, downstreamPolicy);
    const limits = resolveProxyFailoverLimits(eligibleCount);
    maxRetries = limits.maxRetries;
    failoverBudgetMs = limits.budgetMs;
  } catch {
    // keep static maxRetries fallback
  }

  const requestTraceId = createRequestTraceId();
  const failureToolkit = createSurfaceFailureToolkit({
    warningScope: 'chat',
    downstreamPath,
    maxRetries,
    clientContext,
    downstreamApiKeyId,
    traceId: requestTraceId,
  });
  const stickySessionKey = buildSurfaceStickySessionKey({
    clientContext,
    requestedModel,
    downstreamPath,
    downstreamApiKeyId,
  });
  const debugTrace = await startSurfaceProxyDebugTrace({
    downstreamPath,
    clientKind: clientContext.clientKind,
    sessionId: clientContext.sessionId || null,
    traceHint: clientContext.traceHint || null,
    requestedModel,
    downstreamApiKeyId,
    requestHeaders: request.headers as Record<string, unknown>,
    requestBody: rawBody,
  });
  const finalizeDebugFailure = async (status: number, payload: unknown, upstreamPath: string | null = null) => {
    await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
      finalStatus: 'failed',
      finalHttpStatus: status,
      finalUpstreamPath: upstreamPath,
      finalResponseHeaders: {
        'content-type': 'application/json',
      },
      finalResponseBody: payload,
    });
  };
  const finalizeDebugSuccess = async (status: number, upstreamPath: string | null, responseHeaders: unknown, responseBody: unknown) => {
    await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
      finalStatus: 'success',
      finalHttpStatus: status,
      finalUpstreamPath: upstreamPath,
      finalResponseHeaders: responseHeaders as Record<string, unknown> | null,
      finalResponseBody: responseBody,
    });
  };
  const excludeChannelIds: number[] = [];
  const requestStartedAtMs = Date.now();
    let retryCount = 0;

  while (retryCount <= maxRetries) {
    const stickyPreferredChannelId = retryCount === 0
      ? getSurfaceStickyPreferredChannelId(stickySessionKey)
      : null;
    const selected = await selectSurfaceChannelForAttempt({
      requestedModel,
      downstreamPolicy,
      excludeChannelIds,
      retryCount,
      stickySessionKey,
      forcedChannelId,
    });

    if (!selected) {
      const noChannelMessage = buildForcedChannelUnavailableMessage(forcedChannelId);
      await reportProxyAllFailed({
        model: requestedModel,
        reason: forcedChannelId ? noChannelMessage : 'No available channels after retries',
        outcome: forcedChannelId ? 'request_failed' : 'no_available_channels',
        attemptedChannels: excludeChannelIds.length,
        configuredAttempts: maxRetries + 1,
      });
      await finalizeDebugFailure(503, {
        error: { message: noChannelMessage, type: 'server_error' },
      });
      return reply.code(503).send({
        error: { message: noChannelMessage, type: 'server_error' },
      });
    }

    excludeChannelIds.push(selected.channel.id);
    await safeUpdateSurfaceProxyDebugSelection(debugTrace, {
      stickySessionKey,
      stickyHitChannelId: (
        stickyPreferredChannelId && stickyPreferredChannelId === selected.channel.id
          ? stickyPreferredChannelId
          : null
      ),
      selectedChannelId: selected.channel.id,
      selectedRouteId: selected.channel.routeId ?? null,
      selectedAccountId: selected.account.id,
      selectedSiteId: selected.site.id,
      selectedSitePlatform: selected.site.platform,
    });
    const modelName = selected.actualModel || requestedModel;
    const endpointRuntimeContext = {
      siteId: selected.site.id,
      modelName,
      downstreamFormat: 'claude' as const,
      requestedModelHint: requestedModel,
    };
    const endpointCandidates = await resolveUpstreamEndpointCandidates(
      {
        site: selected.site,
        account: selected.account,
      },
      modelName,
      'claude',
      requestedModel,
      undefined,
      {
        requestKind: 'claude-count-tokens',
      },
    );
    await safeUpdateSurfaceProxyDebugCandidates(debugTrace, {
      endpointCandidates,
      endpointRuntimeState: getUpstreamEndpointRuntimeStateSnapshot(endpointRuntimeContext),
      decisionSummary: {
        retryCount,
        stickySessionKey,
        stickyPreferredChannelId,
        countTokens: true,
      },
    });
    if (endpointCandidates.length === 0) {
      if (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })) {
        retryCount += 1;
        continue;
      }
      await finalizeDebugFailure(501, {
        error: {
          message: 'Claude count_tokens compatibility is not implemented for this upstream',
          type: 'invalid_request_error',
        },
      });
      return reply.code(501).send({
        error: {
          message: 'Claude count_tokens compatibility is not implemented for this upstream',
          type: 'invalid_request_error',
        },
      });
    }
    const oauth = getOauthInfoFromAccount(selected.account);
    const startTime = Date.now();
    const leaseResult = await acquireSurfaceChannelLease({
      stickySessionKey,
      selected,
    });
    if (leaseResult.status === 'timeout') {
      clearSurfaceStickyChannel({
        stickySessionKey,
        selected,
      });
      const busyMessage = buildSurfaceChannelBusyMessage(leaseResult.waitMs);
      await failureToolkit.log({
        selected,
        modelRequested: requestedModel,
        status: 'failed',
        httpStatus: 503,
        latencyMs: leaseResult.waitMs,
        errorMessage: busyMessage,
        retryCount,
      });
      if (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })) {
        retryCount += 1;
        continue;
      }
      await finalizeDebugFailure(503, {
        error: {
          message: busyMessage,
          type: 'server_error',
        },
      });
      return reply.code(503).send({
        error: {
          message: busyMessage,
          type: 'server_error',
        },
      });
    }
    const channelLease = leaseResult.lease;

    const buildRequest = () => {
      const upstreamRequest = buildClaudeCountTokensUpstreamRequest({
        modelName,
        tokenValue: selected.tokenValue,
        oauthProvider: oauth?.provider,
        sitePlatform: selected.site.platform,
        claudeBody: rawBody,
        downstreamHeaders: request.headers as Record<string, unknown>,
      });
      return {
        endpoint: 'messages' as const,
        path: upstreamRequest.path,
        headers: upstreamRequest.headers,
        body: upstreamRequest.body,
        runtime: upstreamRequest.runtime,
      };
    };

    try {
      const countTokensResult = await runWithSiteApiEndpointPool(selected.site, async (target) => {
        let upstreamRequest = buildRequest();
        const dispatchRequest = createSurfaceDispatchRequest({
          site: selected.site,
          siteUrl: target.baseUrl,
          accountExtraConfig: selected.account.extraConfig,
        });
        let upstream = await dispatchRequest(upstreamRequest);
        let recoverApplied = false;

        if ((upstream.status === 401 || upstream.status === 403) && oauth) {
          const recoverContext = {
            request: upstreamRequest,
            response: upstream,
            rawErrText: '',
          };
          const recovered = await trySurfaceOauthRefreshRecovery({
            ctx: recoverContext,
            selected,
            siteUrl: target.baseUrl,
            buildRequest: () => buildRequest(),
            dispatchRequest,
            captureFailureBody: false,
          });
          if (recovered?.upstream?.ok) {
            upstreamRequest = buildRequest();
            upstream = recovered.upstream;
            recoverApplied = true;
          } else {
            upstreamRequest = recoverContext.request;
            upstream = recoverContext.response;
          }
        }

        const latency = Date.now() - startTime;
        const contentType = upstream.headers.get('content-type') || 'application/json';
        const text = await readRuntimeResponseText(upstream);
        let payload: unknown = text;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
        await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
          attemptIndex: retryCount,
          endpoint: upstreamRequest.endpoint,
          requestPath: upstreamRequest.path,
          targetUrl: `${target.baseUrl}${upstreamRequest.path}`,
          runtimeExecutor: upstreamRequest.runtime?.executor || 'default',
          requestHeaders: upstreamRequest.headers,
          requestBody: upstreamRequest.body,
          responseStatus: upstream.status,
          responseHeaders: buildSurfaceProxyDebugResponseHeaders(upstream),
          responseBody: payload,
          rawErrorText: upstream.ok ? null : text,
          recoverApplied,
          downgradeDecision: false,
          downgradeReason: null,
          memoryWrite: null,
        });
        if (!upstream.ok) {
          const errText = typeof payload === 'string' ? payload : JSON.stringify(payload);
          throw new SiteApiEndpointRequestError(errText || 'unknown error', {
            status: upstream.status,
            rawErrText: typeof payload === 'string' ? payload : text,
          });
        }
        return {
          upstream,
          upstreamRequest,
          contentType,
          payload,
          latency,
        };
      });

      const {
        upstream,
        upstreamRequest,
        contentType,
        payload,
        latency,
      } = countTokensResult;

      tokenRouter.recordSuccess(selected.channel.id, latency, 0, modelName);
      recordDownstreamCostUsage(request, 0);
      await failureToolkit.log({
        selected,
        modelRequested: requestedModel,
        status: 'success',
        httpStatus: upstream.status,
        latencyMs: latency,
        errorMessage: null,
        retryCount,
        upstreamPath: upstreamRequest.path,
      });
      bindSurfaceStickyChannel({
        stickySessionKey,
        selected,
      });
      await finalizeDebugSuccess(
        upstream.status,
        upstreamRequest.path,
        buildSurfaceProxyDebugResponseHeaders(upstream),
        payload,
      );
      return reply.code(upstream.status).type(contentType).send(payload);
    } catch (error: any) {
      clearSurfaceStickyChannel({
        stickySessionKey,
        selected,
      });
      const endpointFailureStatus = typeof error?.status === 'number' ? error.status : null;
      const isSiteApiEndpointFailure = (
        error instanceof SiteApiEndpointRequestError
        || error?.name === 'SiteApiEndpointRequestError'
        || error?.siteApiEndpointUpstreamFailure === true
        || error?.serviceTierBlocked === true
        || (endpointFailureStatus !== null && endpointFailureStatus >= 500)
      );
      if (error?.serviceTierBlocked === true) {
        let payload: unknown = null;
        try {
          payload = JSON.parse(error.rawErrText || '');
        } catch {
          payload = {
            error: {
              message: error.message || 'service_tier is blocked by policy',
              type: 'invalid_request_error',
            },
          };
        }
        await finalizeDebugFailure(endpointFailureStatus || 400, payload, null);
        return reply.code(endpointFailureStatus || 400).send(payload);
      }
      if (isSiteApiEndpointFailure) {
        const failureOutcome = await failureToolkit.handleUpstreamFailure({
          selected,
          requestedModel,
          modelName,
          status: endpointFailureStatus || 502,
          errText: error.message || 'unknown error',
          rawErrText: error.rawErrText || error.message || 'unknown error',
          isStream: false,
          latencyMs: Date.now() - startTime,
          retryCount,
        });
        const terminalFailureOutcome = failureOutcome.action === 'retry'
          ? (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })
            ? null
            : finalizeRetryAsUpstreamFailure(endpointFailureStatus || 502, error.message || 'unknown error'))
          : failureOutcome;
        if (!terminalFailureOutcome) {
          retryCount += 1;
          continue;
        }
        await finalizeDebugFailure(terminalFailureOutcome.status, terminalFailureOutcome.payload, null);
        return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
      }
      const failureOutcome = await failureToolkit.handleExecutionError({
        selected,
        requestedModel,
        modelName,
        errorMessage: error?.message || 'network failure',
        isStream: false,
        latencyMs: Date.now() - startTime,
        retryCount,
      });
      const terminalFailureOutcome = failureOutcome.action === 'retry'
        ? (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })
          ? null
          : finalizeRetryAsExecutionFailure(error?.message || 'network failure'))
        : failureOutcome;
      if (!terminalFailureOutcome) {
        retryCount += 1;
        continue;
      }
      await finalizeDebugFailure(terminalFailureOutcome.status, terminalFailureOutcome.payload, null);
      return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
    } finally {
      channelLease.release();
    }
  }
}
