import { TextDecoder } from 'node:util';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../config.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { reportProxyAllFailed } from '../../services/alertService.js';
import { hasProxyUsagePayload, mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { type DownstreamFormat } from '../../transformers/shared/normalized.js';
import { promoteRequiredEndpointCandidateAfterProtocolError } from '../../transformers/shared/endpointCompatibility.js';

import { shouldForceResponsesUpstreamStream } from '../capabilities/responsesCompact.js';
import {
  buildClaudeCountTokensUpstreamRequest,
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
} from '../../services/upstreamEndpointRuntime.js';
import {
  getUpstreamEndpointRuntimeStateSnapshot,
  recordUpstreamEndpointFailure,
  recordUpstreamEndpointSuccess,
} from '../../services/upstreamEndpointRuntimeMemory.js';
import {
  ensureModelAllowedForDownstreamKey,
  getDownstreamRoutingPolicy,
  recordDownstreamCostUsage,
} from '../../services/downstreamPolicyRequest.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../orchestration/endpointFlow.js';
import { detectProxyFailure } from '../../services/proxyFailureJudge.js';
import { openAiChatTransformer } from '../../transformers/openai/chat/index.js';
import { anthropicMessagesTransformer } from '../../transformers/anthropic/messages/index.js';
import { shouldPreferResponsesForAnthropicContinuation } from '../../transformers/anthropic/messages/compatibility.js';
import { getProxyAuthContext, getProxyResourceOwner } from '../../middleware/auth.js';
import {
  ProxyInputFileResolutionError,
  resolveOpenAiBodyInputFiles,
} from '../../services/proxyInputFileResolver.js';
import {
  buildOauthProviderHeaders,
} from '../../services/oauth/service.js';
import { getOauthInfoFromAccount } from '../../services/oauth/oauthAccount.js';
import {
  collectResponsesFinalPayloadFromSse,
  collectResponsesFinalPayloadFromSseText,
  createSingleChunkStreamReader,
  looksLikeResponsesSseText,
} from '../runtime/responsesSseFinal.js';
import {
  createGeminiCliStreamReader,
  unwrapGeminiCliPayload,
} from '../../transformers/gemini/generate-content/cliBridge.js';
import { geminiGenerateContentTransformer } from '../../transformers/gemini/generate-content/index.js';
import { summarizeConversationFileInputsInOpenAiBody } from '../capabilities/conversationFileCapabilities.js';
import { getObservedResponseMeta } from '../firstByteTimeout.js';
import { getRuntimeResponseReader, readRuntimeResponseText } from '../executors/types.js';
import { detectDownstreamClientContext } from '../downstreamClientContext.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import { shouldAbortSameSiteEndpointFallback } from '../../services/proxyRetryPolicy.js';
import { createRequestTraceId } from '../../services/requestTraceId.js';
import { applyOpenAiServiceTierPolicy } from '../serviceTierPolicy.js';
import { maybeHandleWebSearchOnlySimulation } from '../webSearchSimulation.js';
import {
  acquireSurfaceChannelLease,
  bindSurfaceStickyChannel,
  buildSurfaceChannelBusyMessage,
  buildSurfaceStickySessionKey,
  clearSurfaceStickyChannel,
  createSurfaceFailureToolkit,
  createSurfaceDispatchRequest,
  getSurfaceStickyPreferredChannelId,
  recordSurfaceSuccess,
  selectSurfaceChannelForAttempt,
  trySurfaceOauthRefreshRecovery,
} from './sharedSurface.js';
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import {
  buildSurfaceProxyDebugResponseHeaders,
  captureSurfaceProxyDebugSuccessResponseBody,
  parseSurfaceProxyDebugTextPayload,
  reserveSurfaceProxyDebugAttemptBase,
  safeFinalizeSurfaceProxyDebugTrace,
  safeInsertSurfaceProxyDebugAttempt,
  safeUpdateSurfaceProxyDebugAttempt,
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
  buildOpenAiFinalFromGeminiNativePayload,
  buildOpenAiStreamLinesFromGeminiNativeSse,
  deriveCodexSessionCacheKey,
  finalizeRetryAsExecutionFailure,
  finalizeRetryAsUpstreamFailure,
  isGeminiNativeRuntimePath,
  isRecord,
} from './chatSurfaceHelpers.js';
import { isFastifyReplyCommitted, sendReplyIfWritable } from '../replySafety.js';

export async function handleChatSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  downstreamFormat: DownstreamFormat,
) {
  const downstreamTransformer = downstreamFormat === 'claude'
    ? anthropicMessagesTransformer
    : openAiChatTransformer;
  const downstreamPath = downstreamFormat === 'claude' ? '/v1/messages' : '/v1/chat/completions';
  const clientContext = detectDownstreamClientContext({
    downstreamPath,
    headers: request.headers as Record<string, unknown>,
    body: request.body,
  });
  const parsedRequestEnvelope = downstreamTransformer.transformRequest(request.body);
  if (parsedRequestEnvelope.error) {
    return reply.code(parsedRequestEnvelope.error.statusCode).send(parsedRequestEnvelope.error.payload);
  }

  const requestEnvelope = parsedRequestEnvelope.value!;
  const {
    requestedModel,
    isStream,
    upstreamBody,
    claudeOriginalBody,
  } = requestEnvelope.parsed;
  if (downstreamFormat === 'claude') {
    const handledSearch = await maybeHandleWebSearchOnlySimulation({
      app: request.server,
      request,
      reply,
      downstreamFormat: 'claude',
      body: (claudeOriginalBody || request.body || {}) as Record<string, unknown>,
      openAiBody: upstreamBody,
    });
    if (handledSearch) return;
  }
  if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
  const downstreamPolicy = getDownstreamRoutingPolicy(request);
  const forcedChannelId = getTesterForcedChannelId({
    headers: request.headers as Record<string, unknown>,
    clientIp: request.ip,
  });
  const owner = getProxyResourceOwner(request);
  let resolvedOpenAiBody = upstreamBody;
  if (owner) {
    try {
      resolvedOpenAiBody = await resolveOpenAiBodyInputFiles(upstreamBody, owner);
    } catch (error) {
      if (error instanceof ProxyInputFileResolutionError) {
        return reply.code(error.statusCode).send(error.payload);
      }
      throw error;
    }
  }
  const conversationFileSummary = summarizeConversationFileInputsInOpenAiBody(resolvedOpenAiBody);
  const hasNonImageFileInput = conversationFileSummary.hasDocument;
  const wantsContinuationAwareResponses = (
    downstreamFormat === 'claude'
    && shouldPreferResponsesForAnthropicContinuation(claudeOriginalBody)
  );
  const codexSessionCacheKey = deriveCodexSessionCacheKey({
    downstreamFormat,
    body: downstreamFormat === 'claude' ? claudeOriginalBody : request.body,
    requestedModel,
    proxyToken: getProxyAuthContext(request)?.token || null,
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
    requestBody: request.body,
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
      const payload = {
        error: { message: noChannelMessage, type: 'server_error' as const },
      };
      await finalizeDebugFailure(503, payload, null);
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
    const oauth = getOauthInfoFromAccount(selected.account);
    const isCodexSite = String(selected.site.platform || '').trim().toLowerCase() === 'codex';
    let endpointCandidates = [
      ...await resolveUpstreamEndpointCandidates(
        {
          site: selected.site,
          account: selected.account,
        },
        modelName,
        downstreamFormat,
        requestedModel,
        {
          hasNonImageFileInput,
          conversationFileSummary,
          wantsContinuationAwareResponses,
        },
        {
          oauthProvider: oauth?.provider,
        },
      ),
    ];
    const endpointRuntimeContext = {
      siteId: selected.site.id,
      modelName,
      downstreamFormat,
      requestedModelHint: requestedModel,
      requestCapabilities: {
        hasNonImageFileInput,
        conversationFileSummary,
        wantsContinuationAwareResponses,
      },
    };
    await safeUpdateSurfaceProxyDebugCandidates(debugTrace, {
      endpointCandidates,
      endpointRuntimeState: getUpstreamEndpointRuntimeStateSnapshot(endpointRuntimeContext),
      decisionSummary: {
        retryCount,
        downstreamFormat,
        stickySessionKey,
        stickyPreferredChannelId,
        oauthProvider: oauth?.provider || null,
        isCodexSite,
        wantsContinuationAwareResponses,
      },
    });
    const buildProviderHeaders = () => (
      buildOauthProviderHeaders({
        account: selected.account,
        downstreamHeaders: request.headers as Record<string, unknown>,
      })
    );
    const executeEndpointResultForSiteApiBaseUrl = async (siteApiBaseUrl: string) => {
      const forceResponsesUpstreamStream = shouldForceResponsesUpstreamStream({
        sitePlatform: selected.site.platform,
        isCompactRequest: false,
      });
      const buildEndpointRequest = (
        endpoint: 'chat' | 'messages' | 'responses',
        options: { forceNormalizeClaudeBody?: boolean } = {},
      ) => {
        const upstreamStream = isStream || (forceResponsesUpstreamStream && endpoint === 'responses');
        const bodyForEndpoint = endpoint === 'responses'
          ? (() => {
            const policyResult = applyOpenAiServiceTierPolicy({
              body: resolvedOpenAiBody,
              context: {
                requestedModel,
                actualModel: modelName,
                sitePlatform: selected.site.platform,
                accountType: oauth?.planType,
              },
              rules: (config as any).openAiServiceTierRules,
            });
            if (!policyResult.ok) {
              const error = new SiteApiEndpointRequestError(policyResult.payload.error.message, {
                status: policyResult.statusCode,
                rawErrText: JSON.stringify(policyResult.payload),
              });
              (error as SiteApiEndpointRequestError & { serviceTierBlocked?: boolean }).serviceTierBlocked = true;
              throw error;
            }
            return policyResult.body;
          })()
          : resolvedOpenAiBody;
        const endpointRequest = buildUpstreamEndpointRequest({
          endpoint,
          modelName,
          stream: upstreamStream,
          tokenValue: selected.tokenValue,
          oauthProvider: oauth?.provider,
          oauthProjectId: oauth?.projectId,
          sitePlatform: selected.site.platform,
          siteUrl: siteApiBaseUrl,
          openaiBody: bodyForEndpoint,
          downstreamFormat,
          claudeOriginalBody,
          forceNormalizeClaudeBody: options.forceNormalizeClaudeBody,
          downstreamHeaders: request.headers as Record<string, unknown>,
          providerHeaders: buildProviderHeaders(),
          codexSessionCacheKey,
        });
        return {
          endpoint,
          path: endpointRequest.path,
          headers: endpointRequest.headers,
          body: endpointRequest.body as Record<string, unknown>,
          runtime: endpointRequest.runtime,
        };
      };
      const dispatchRequest = createSurfaceDispatchRequest({
        site: selected.site,
        siteUrl: siteApiBaseUrl,
        accountExtraConfig: selected.account.extraConfig,
      });
      const endpointStrategy = downstreamTransformer.compatibility.createEndpointStrategy({
        downstreamFormat,
        endpointCandidates,
        modelName,
        requestedModelHint: requestedModel,
        sitePlatform: selected.site.platform,
        isStream: isStream || forceResponsesUpstreamStream,
        buildRequest: ({ endpoint, forceNormalizeClaudeBody }) => buildEndpointRequest(
          endpoint,
          { forceNormalizeClaudeBody },
        ),
        dispatchRequest,
      });
      const tryRecover = async (ctx: Parameters<NonNullable<typeof endpointStrategy.tryRecover>>[0]) => {
        if ((ctx.response.status === 401 || ctx.response.status === 403) && oauth) {
          const recovered = await trySurfaceOauthRefreshRecovery({
            ctx,
            selected,
            siteUrl: siteApiBaseUrl,
            buildRequest: (endpoint) => buildEndpointRequest(endpoint),
            dispatchRequest,
          });
          if (recovered?.upstream?.ok) {
            return recovered;
          }
        }
        return endpointStrategy.tryRecover(ctx);
      };
      const debugAttemptBase = reserveSurfaceProxyDebugAttemptBase(debugTrace, endpointCandidates.length);
      return executeEndpointFlow({
        siteUrl: siteApiBaseUrl,
        disableCrossProtocolFallback: config.disableCrossProtocolFallback,
        firstByteTimeoutMs: Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000)),
        endpointCandidates,
        buildRequest: (endpoint) => buildEndpointRequest(endpoint),
        dispatchRequest,
        tryRecover,
        shouldAbortRemainingEndpoints: (ctx) => shouldAbortSameSiteEndpointFallback(
          ctx.response.status,
          ctx.rawErrText || ctx.errText,
        ),
        onAttemptFailure: async (ctx) => {
          const memoryWrite = recordUpstreamEndpointFailure({
            ...endpointRuntimeContext,
            endpoint: ctx.request.endpoint,
            status: ctx.response.status,
            errorText: ctx.rawErrText,
          });
          await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
            attemptIndex: debugAttemptBase + ctx.endpointIndex,
            endpoint: ctx.request.endpoint,
            requestPath: ctx.request.path,
            targetUrl: ctx.targetUrl,
            runtimeExecutor: ctx.request.runtime?.executor || 'default',
            requestHeaders: ctx.request.headers,
            requestBody: ctx.request.body,
            responseStatus: ctx.response.status,
            responseHeaders: buildSurfaceProxyDebugResponseHeaders(ctx.response),
            responseBody: parseSurfaceProxyDebugTextPayload(ctx.rawErrText),
            rawErrorText: ctx.rawErrText,
            recoverApplied: ctx.recoverApplied === true,
            downgradeDecision: false,
            downgradeReason: null,
            memoryWrite,
          });
        },
        onAttemptSuccess: async (ctx) => {
          const memoryWrite = recordUpstreamEndpointSuccess({
            ...endpointRuntimeContext,
            endpoint: ctx.request.endpoint,
          });

          const responseBody = await captureSurfaceProxyDebugSuccessResponseBody(debugTrace, ctx);
          await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
            attemptIndex: debugAttemptBase + ctx.endpointIndex,
            endpoint: ctx.request.endpoint,
            requestPath: ctx.request.path,
            targetUrl: ctx.targetUrl,
            runtimeExecutor: ctx.request.runtime?.executor || 'default',
            requestHeaders: ctx.request.headers,
            requestBody: ctx.request.body,
            responseStatus: ctx.response.status,
            responseHeaders: buildSurfaceProxyDebugResponseHeaders(ctx.response),
            responseBody,
            rawErrorText: null,
            recoverApplied: ctx.recoverApplied === true,
            downgradeDecision: false,
            downgradeReason: null,
            memoryWrite,
          });
        },
        shouldDowngrade: endpointStrategy.shouldDowngrade,
        onDowngrade: async (ctx) => {
          promoteRequiredEndpointCandidateAfterProtocolError(endpointCandidates, {
            currentEndpoint: ctx.request.endpoint,
            upstreamErrorText: ctx.rawErrText,
          });

          await safeUpdateSurfaceProxyDebugAttempt(debugTrace, debugAttemptBase + ctx.endpointIndex, {
            downgradeDecision: true,
            downgradeReason: ctx.errText,
            rawErrorText: ctx.rawErrText,
          });
          return failureToolkit.log({
            selected,
            modelRequested: requestedModel,
            status: 'failed',
            httpStatus: ctx.response.status,
            latencyMs: Date.now() - startTime,
            errorMessage: ctx.errText,
            retryCount,
          });
        },
      });
    };
    let startTime = Date.now();
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

    try {
      const endpointResult = await runWithSiteApiEndpointPool(selected.site, async (target) => {
        const result = await executeEndpointResultForSiteApiBaseUrl(target.baseUrl);
        if (!result.ok) {
          const upstreamFailure = new SiteApiEndpointRequestError(result.errText || 'unknown error', {
            status: result.status || 502,
            rawErrText: result.rawErrText || result.errText || 'unknown error',
          }) as SiteApiEndpointRequestError & { siteApiEndpointUpstreamFailure?: boolean };
          upstreamFailure.siteApiEndpointUpstreamFailure = true;
          throw upstreamFailure;
        }
        return result;
      });

      const upstream = endpointResult.upstream;
      const successfulUpstreamPath = endpointResult.upstreamPath;
      const firstByteLatencyMs = getObservedResponseMeta(upstream)?.firstByteLatencyMs ?? null;

      if (isStream) {
        const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
        let streamStarted = false;
        const startSseResponse = () => {
          if (streamStarted) return;
          streamStarted = true;
          reply.hijack();
          reply.raw.statusCode = 200;
          reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
          reply.raw.setHeader('Connection', 'keep-alive');
          reply.raw.setHeader('X-Accel-Buffering', 'no');
        };

        let parsedUsage: ReturnType<typeof parseProxyUsage> = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          promptTokensIncludeCache: null,
        };
        let upstreamUsagePresent = false;
        const recordStreamSuccess = async (latencyMs: number) => {
          await recordSurfaceSuccess({
            selected,
            requestedModel,
            modelName,
            parsedUsage,
            upstreamUsagePresent,
            upstreamHeaders: upstream.headers,
            requestStartedAtMs: startTime,
            isStream: true,
            firstByteLatencyMs,
            latencyMs,
            retryCount,
            upstreamPath: successfulUpstreamPath,
            logSuccess: failureToolkit.log,
            recordDownstreamCost: (estimatedCost) => {
              recordDownstreamCostUsage(request, estimatedCost);
            },
            bestEffortMetrics: {
              errorLabel: '[proxy/chat] failed to record success metrics',
            },
          });
        };

        const writeLines = (lines: string[]) => {
          startSseResponse();
          for (const line of lines) {
            reply.raw.write(line);
          }
        };
        const streamResponse = {
          end() {
            if (streamStarted) {
              reply.raw.end();
            }
          },
        };
        const streamSession = openAiChatTransformer.proxyStream.createSession({
          downstreamFormat,
          modelName,
          successfulUpstreamPath,
          onParsedPayload: (payload) => {
            if (payload && typeof payload === 'object') {
              upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(payload);
              parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(payload));
            }
          },
          writeLines,
          writeRaw: (chunk) => {
            startSseResponse();
            reply.raw.write(chunk);
          },
        });
        let rawText = '';
        if (isGeminiNativeRuntimePath(successfulUpstreamPath)) {
          rawText = await readRuntimeResponseText(upstream);
          const bridged = buildOpenAiStreamLinesFromGeminiNativeSse(
            rawText,
            modelName,
          );
          upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(bridged.finalPayload);
          parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(bridged.finalPayload));
          writeLines(bridged.lines);
          streamResponse.end();

          const latency = Date.now() - startTime;
          await recordStreamSuccess(latency);
          await finalizeDebugSuccess(
            200,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            debugTrace?.options.captureStreamChunks
              ? rawText
              : {
                stream: true,
                usage: parsedUsage,
              },
          );
          bindSurfaceStickyChannel({
            stickySessionKey,
            selected,
          });
          return;
        }
        if (!upstreamContentType.includes('text/event-stream')) {
          const fallbackText = await readRuntimeResponseText(upstream);
          rawText = fallbackText;
          if (looksLikeResponsesSseText(fallbackText)) {
            const streamResult = await streamSession.run(
              createSingleChunkStreamReader(fallbackText),
              streamResponse,
            );
            const latency = Date.now() - startTime;
            if (streamResult.status === 'failed') {
              clearSurfaceStickyChannel({
                stickySessionKey,
                selected,
              });
              await failureToolkit.recordStreamFailure({
                selected,
                requestedModel,
                modelName,
                errorMessage: streamResult.errorMessage,
                latencyMs: latency,
                retryCount,
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
                upstreamPath: successfulUpstreamPath,
              });
              await finalizeDebugFailure(502, {
                error: {
                  message: streamResult.errorMessage,
                  type: 'stream_error',
                },
              }, successfulUpstreamPath);
              if (!streamStarted) {
                return reply.code(502).send({
                  error: {
                    message: streamResult.errorMessage,
                    type: 'upstream_error',
                  },
                });
              }
              return;
            }
            await recordStreamSuccess(latency);
            await finalizeDebugSuccess(
              200,
              successfulUpstreamPath,
              buildSurfaceProxyDebugResponseHeaders(upstream),
              debugTrace?.options.captureStreamChunks
                ? fallbackText
                : {
                  stream: true,
                  usage: parsedUsage,
                },
            );
            bindSurfaceStickyChannel({
              stickySessionKey,
              selected,
            });
            return;
          }
          let fallbackData: unknown = null;
          try {
            fallbackData = JSON.parse(fallbackText);
          } catch {
            fallbackData = fallbackText;
          }
          if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
            fallbackData = unwrapGeminiCliPayload(fallbackData);
          }
          upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(fallbackData);
          parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(fallbackData));
          const latency = Date.now() - startTime;
          const failure = detectProxyFailure({ rawText, usage: parsedUsage });
          if (failure) {
            clearSurfaceStickyChannel({
              stickySessionKey,
              selected,
            });
            const failureOutcome = await failureToolkit.handleDetectedFailure({
              selected,
              requestedModel,
              modelName,
              failure,
              latencyMs: latency,
              retryCount,
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
              upstreamPath: successfulUpstreamPath,
            });
            const terminalFailureOutcome = failureOutcome.action === 'retry'
              ? (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })
                ? null
                : finalizeRetryAsUpstreamFailure(failure.status, failure.reason))
              : failureOutcome;
            if (!terminalFailureOutcome) {
              retryCount += 1;
              continue;
            }
            await finalizeDebugFailure(
              terminalFailureOutcome.status,
              terminalFailureOutcome.payload,
              successfulUpstreamPath,
            );
            return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
          }

          const streamResult = streamSession.consumeUpstreamFinalPayload(fallbackData, fallbackText, streamResponse);
          if (streamResult.status === 'failed') {
            clearSurfaceStickyChannel({
              stickySessionKey,
              selected,
            });
            await failureToolkit.recordStreamFailure({
              selected,
              requestedModel,
              modelName,
              errorMessage: streamResult.errorMessage,
              latencyMs: latency,
              retryCount,
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
              upstreamPath: successfulUpstreamPath,
              runtimeFailureStatus: 502,
            });
            await finalizeDebugFailure(502, {
              error: {
                message: streamResult.errorMessage,
                type: 'stream_error',
              },
            }, successfulUpstreamPath);
            if (!streamStarted) {
              return reply.code(502).send({
                error: {
                  message: streamResult.errorMessage,
                  type: 'upstream_error',
                },
              });
            }
            return;
          }
          await recordStreamSuccess(latency);
          await finalizeDebugSuccess(
            200,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            debugTrace?.options.captureStreamChunks
              ? fallbackText
              : {
                stream: true,
                usage: parsedUsage,
              },
          );
          bindSurfaceStickyChannel({
            stickySessionKey,
            selected,
          });
          return;
        } else {
          const upstreamReader = getRuntimeResponseReader(upstream);
          const baseReader = String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli' && upstreamReader
            ? createGeminiCliStreamReader(upstreamReader)
            : upstreamReader;
          const decoder = new TextDecoder();
          const reader = baseReader
            ? {
              async read() {
                const result = await baseReader.read();
                if (result.value) {
                  rawText += decoder.decode(result.value, { stream: true });
                }
                return result;
              },
              async cancel(reason?: unknown) {
                return baseReader.cancel(reason);
              },
              releaseLock() {
                return baseReader.releaseLock();
              },
            }
            : baseReader;
          const streamResult = await streamSession.run(reader, streamResponse);
          rawText += decoder.decode();

          const latency = Date.now() - startTime;
          if (streamResult.status === 'failed') {
            clearSurfaceStickyChannel({
              stickySessionKey,
              selected,
            });
            await failureToolkit.recordStreamFailure({
              selected,
              requestedModel,
              modelName,
              errorMessage: streamResult.errorMessage,
              latencyMs: latency,
              retryCount,
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
              upstreamPath: successfulUpstreamPath,
              runtimeFailureStatus: 502,
            });
            await finalizeDebugFailure(502, {
              error: {
                message: streamResult.errorMessage,
                type: 'stream_error',
              },
            }, successfulUpstreamPath);
            if (!streamStarted) {
              return reply.code(502).send({
                error: {
                  message: streamResult.errorMessage,
                  type: 'upstream_error',
                },
              });
            }
            return;
          }

          // Once SSE has been hijacked and streamed downstream, we can no longer
          // safely fall back to an HTTP error response or retry by switching the
          // channel mid-flight. Stream-level failures must be handled in-band by
          // the proxy stream session itself.
        }

        const latency = Date.now() - startTime;
        await recordStreamSuccess(latency);
        await finalizeDebugSuccess(
          200,
          successfulUpstreamPath,
          buildSurfaceProxyDebugResponseHeaders(upstream),
          debugTrace?.options.captureStreamChunks
            ? rawText
            : {
              stream: true,
              usage: parsedUsage,
            },
        );
        bindSurfaceStickyChannel({
          stickySessionKey,
          selected,
        });
        return;
      }

      const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
      let rawText = '';
      let upstreamData: unknown;
      if (upstreamContentType.includes('text/event-stream') && successfulUpstreamPath.endsWith('/responses')) {
        const collected = await collectResponsesFinalPayloadFromSse(upstream, modelName);
        rawText = collected.rawText;
        upstreamData = collected.payload;
      } else {
        rawText = await readRuntimeResponseText(upstream);
        if (looksLikeResponsesSseText(rawText)) {
          upstreamData = collectResponsesFinalPayloadFromSseText(rawText, modelName).payload;
        } else {
          upstreamData = rawText;
          try {
            upstreamData = JSON.parse(rawText);
          } catch {
            upstreamData = rawText;
          }
        }
      }
      if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
        upstreamData = unwrapGeminiCliPayload(upstreamData);
      }

      const latency = Date.now() - startTime;
      const parsedUsage = parseProxyUsage(upstreamData);
      const upstreamUsagePresent = hasProxyUsagePayload(upstreamData);
      const failure = detectProxyFailure({ rawText, usage: parsedUsage });
      if (failure) {
        clearSurfaceStickyChannel({
          stickySessionKey,
          selected,
        });
        const failureOutcome = await failureToolkit.handleDetectedFailure({
          selected,
          requestedModel,
          modelName,
          failure,
          latencyMs: latency,
          retryCount,
          promptTokens: parsedUsage.promptTokens,
          completionTokens: parsedUsage.completionTokens,
          totalTokens: parsedUsage.totalTokens,
          upstreamPath: successfulUpstreamPath,
        });
        const terminalFailureOutcome = failureOutcome.action === 'retry'
          ? (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })
            ? null
            : finalizeRetryAsUpstreamFailure(failure.status, failure.reason))
          : failureOutcome;
        if (!terminalFailureOutcome) {
          retryCount += 1;
          continue;
        }
        await finalizeDebugFailure(
          terminalFailureOutcome.status,
          terminalFailureOutcome.payload,
          successfulUpstreamPath,
        );
        return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
      }
      const normalizedFinal = isGeminiNativeRuntimePath(successfulUpstreamPath)
        ? buildOpenAiFinalFromGeminiNativePayload(upstreamData, modelName, rawText)
        : downstreamTransformer.transformFinalResponse(upstreamData, modelName, rawText);
      const downstreamResponse = downstreamTransformer.serializeFinalResponse(normalizedFinal, parsedUsage);

      await recordSurfaceSuccess({
        selected,
        requestedModel,
        modelName,
        parsedUsage,
        upstreamUsagePresent,
        upstreamHeaders: upstream.headers,
        requestStartedAtMs: startTime,
        isStream: false,
        firstByteLatencyMs,
        latencyMs: latency,
        retryCount,
        upstreamPath: successfulUpstreamPath,
        logSuccess: failureToolkit.log,
        recordDownstreamCost: (estimatedCost) => {
          recordDownstreamCostUsage(request, estimatedCost);
        },
        bestEffortMetrics: {
          errorLabel: '[proxy/chat] failed to record success metrics',
        },
      });
      await finalizeDebugSuccess(
        upstream.status,
        successfulUpstreamPath,
        buildSurfaceProxyDebugResponseHeaders(upstream),
        downstreamResponse,
      );
      bindSurfaceStickyChannel({
        stickySessionKey,
        selected,
      });

      return reply.send(downstreamResponse);
    } catch (err: any) {
      clearSurfaceStickyChannel({
        stickySessionKey,
        selected,
      });
      const endpointFailureStatus = typeof err?.status === 'number' ? err.status : null;
      const isSiteApiEndpointFailure = (
        err instanceof SiteApiEndpointRequestError
        || err?.name === 'SiteApiEndpointRequestError'
        || err?.siteApiEndpointUpstreamFailure === true
        || err?.serviceTierBlocked === true
        || (endpointFailureStatus !== null && endpointFailureStatus >= 500)
      );
      if (err?.serviceTierBlocked === true) {
        let payload: unknown = null;
        try {
          payload = JSON.parse(err.rawErrText || '');
        } catch {
          payload = {
            error: {
              message: err.message || 'service_tier is blocked by policy',
              type: 'invalid_request_error',
            },
          };
        }
        await finalizeDebugFailure(endpointFailureStatus || 400, payload, null);
        sendReplyIfWritable(reply, endpointFailureStatus || 400, payload);
        return;
      }
      if (isSiteApiEndpointFailure) {
        const failureOutcome = await failureToolkit.handleUpstreamFailure({
          selected,
          requestedModel,
          modelName,
          status: endpointFailureStatus || 502,
          errText: err.message || 'unknown error',
          rawErrText: err.rawErrText || err.message || 'unknown error',
          isStream,
          latencyMs: Date.now() - startTime,
          retryCount,
        });
        const terminalFailureOutcome = failureOutcome.action === 'retry'
          ? (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })
            ? null
            : finalizeRetryAsUpstreamFailure(endpointFailureStatus || 502, err.message || 'unknown error'))
          : failureOutcome;
        if (!terminalFailureOutcome) {
          retryCount += 1;
          continue;
        }
        await finalizeDebugFailure(
          terminalFailureOutcome.status,
          terminalFailureOutcome.payload,
          null,
        );
        sendReplyIfWritable(reply, terminalFailureOutcome.status, terminalFailureOutcome.payload);
        return;
      }
      const failureOutcome = await failureToolkit.handleExecutionError({
        selected,
        requestedModel,
        modelName,
        errorMessage: err?.message || 'network failure',
        isStream,
        latencyMs: Date.now() - startTime,
        retryCount,
      });
      const terminalFailureOutcome = failureOutcome.action === 'retry'
        ? (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })
          ? null
          : finalizeRetryAsExecutionFailure(err?.message || 'network failure'))
        : failureOutcome;
      if (!terminalFailureOutcome) {
        retryCount += 1;
        continue;
      }
      await finalizeDebugFailure(
        terminalFailureOutcome.status,
        terminalFailureOutcome.payload,
        null,
      );
      sendReplyIfWritable(reply, terminalFailureOutcome.status, terminalFailureOutcome.payload);
      return;
      } finally {
        channelLease.release();
      }
    }
}

export { handleClaudeCountTokensSurfaceRequest } from './chatSurfaceCountTokens.js';
