import { TextDecoder } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { reportProxyAllFailed } from '../../services/alertService.js';
import { hasProxyUsagePayload, mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import {isResponsesPreviousResponseNotFoundError, shouldInferResponsesPreviousResponseId, stripResponsesPreviousResponseId, withResponsesPreviousResponseId} from '../../transformers/openai/responses/continuation.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from '../../services/upstreamEndpointRuntime.js';
import {
  getUpstreamEndpointRuntimeStateSnapshot,
  recordUpstreamEndpointFailure,
  recordUpstreamEndpointSuccess,
} from '../../services/upstreamEndpointRuntimeMemory.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from '../../services/downstreamPolicyRequest.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../orchestration/endpointFlow.js';
import { detectProxyFailure } from '../../services/proxyFailureJudge.js';
import { getProxyAuthContext, getProxyResourceOwner } from '../../middleware/auth.js';
import { promoteRequiredEndpointCandidateAfterProtocolError } from '../../transformers/shared/endpointCompatibility.js';

import {
  ProxyInputFileResolutionError,
  resolveResponsesBodyInputFiles,
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
import { isCodexResponsesSurface } from '../cliProfiles/codexProfile.js';
import { getObservedResponseMeta } from '../firstByteTimeout.js';
import { getRuntimeResponseReader, readRuntimeResponseText } from '../executors/types.js';
import { runCodexHttpSessionTask } from '../runtime/codexHttpSessionQueue.js';
import {buildCodexSessionResponseStoreKey, clearCodexSessionResponseId, getCodexSessionResponseId} from '../runtime/codexSessionResponseStore.js';
import {
  summarizeConversationFileInputsInOpenAiBody,
  summarizeConversationFileInputsInResponsesBody,
} from '../capabilities/conversationFileCapabilities.js';
import {
  ensureCompactResponsesJsonAcceptHeader,
  sanitizeCompactResponsesRequestBody,
  shouldForceResponsesUpstreamStream,
  shouldFallbackCompactResponsesToResponses,
} from '../capabilities/responsesCompact.js';
import { detectDownstreamClientContext } from '../downstreamClientContext.js';
import { validateExternalResponsesHttpRequest } from '../responsesPreflight.js';
import { applyOpenAiServiceTierPolicy } from '../serviceTierPolicy.js';
import { maybeHandleWebSearchOnlySimulation } from '../webSearchSimulation.js';
import {
  getProxyMaxChannelRetries,
  resolveProxyChannelFirstByteTimeoutMs,
} from '../../services/proxyChannelRetry.js';
import { createRequestTraceId } from '../../services/requestTraceId.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { shouldAbortSameSiteEndpointFallback, resolveFailoverBackoffMs, sleepMs, canRetryInPlaceForRecoveringFailure, isRecoveringTransientFailure, shouldGraceRetryInPlace } from '../../services/proxyRetryPolicy.js';
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
  wireStreamCancelOnClientDisconnect,
} from './sharedSurface.js';
import { proxyChannelCoordinator } from '../../services/proxyChannelCoordinator.js';
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
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import {
  buildForcedChannelUnavailableMessage,
  canRetryChannelSelection,
  getTesterForcedChannelId,
  resolveProxyFailoverLimits,
} from '../channelSelection.js';
import { canFailoverToNextChannel, isFastifyReplyCommitted, sendReplyIfWritable } from '../replySafety.js';
import {carriesResponsesFileUrlInput, finalizeRetryAsExecutionFailure, finalizeRetryAsUpstreamFailure, getCodexSessionHeaderValue, isRecord, isResponsesWebsocketTransportRequest, rememberCodexSessionResponseId, shouldRefreshOauthResponsesRequest, wantsNativeResponsesReasoning} from './openAiResponsesSurface.pure.js';
type UsageSummary = ReturnType<typeof parseProxyUsage>;

export async function handleOpenAiResponsesSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  downstreamPath: '/v1/responses' | '/v1/responses/compact',
) {
    const body = request.body as Record<string, unknown>;
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });
    const defaultEncryptedReasoningInclude = isCodexResponsesSurface(
      request.headers as Record<string, unknown>,
    );
    if (!isResponsesWebsocketTransportRequest(request.headers as Record<string, unknown>)) {
      const preflight = validateExternalResponsesHttpRequest(body, {
        allowContinuationToolOutput: defaultEncryptedReasoningInclude,
      });
      if (!preflight.ok) {
        return reply.code(preflight.statusCode).send(preflight.payload);
      }
    }
    const parsedRequestEnvelope = openAiResponsesTransformer.transformRequest(body, {
      defaultEncryptedReasoningInclude,
    });
    if (parsedRequestEnvelope.error) {
      return reply.code(parsedRequestEnvelope.error.statusCode).send(parsedRequestEnvelope.error.payload);
    }
    const requestEnvelope = parsedRequestEnvelope.value!;
    const requestedModel = requestEnvelope.model;
    const isStream = requestEnvelope.stream;
    const isCompactRequest = downstreamPath === '/v1/responses/compact';
    if (isCompactRequest && isStream) {
      return reply.code(400).send({
        error: {
          message: 'stream is not supported on /v1/responses/compact',
          type: 'invalid_request_error',
        },
      });
    }
    if (!isCompactRequest) {
      const handledSearch = await maybeHandleWebSearchOnlySimulation({
        app: request.server,
        request,
        reply,
        downstreamFormat: 'responses',
        body: requestEnvelope.parsed.normalizedBody,
      });
      if (handledSearch) return;
    }
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
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
      warningScope: 'responses',
      downstreamPath,
      maxRetries,
      clientContext,
      downstreamApiKeyId,
      traceId: requestTraceId,
      backoffMs: config.proxyFailoverBackoffMs,
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
    const appendExcludedSiteChannels = async (siteId?: number | null) => {
      const normalizedSiteId = typeof siteId === 'number' && Number.isFinite(siteId) ? Math.trunc(siteId) : 0;
      if (normalizedSiteId <= 0) return;
      try {
        const channelIds = await tokenRouter.listChannelIdsForSite(requestedModel, normalizedSiteId, downstreamPolicy);
        for (const channelId of channelIds) {
          if (!excludeChannelIds.includes(channelId)) {
            excludeChannelIds.push(channelId);
          }
        }
      } catch {
        // best-effort
      }
    };
    const requestStartedAtMs = Date.now();
    let retryCount = 0;
    // See chatSurface: when the failover budget is exhausted but every failure
    // was transient-recovering (403 block / 429 / 5xx), one final retry after
    // the backoff window re-selects from the full pool so the previously-good
    // channel can be picked again instead of failing fast.
    let allFailuresRecovering = true;
    let recoveryPass = false;
    let inPlaceRetryChannel: Awaited<ReturnType<typeof tokenRouter.selectChannel>> = null;

    // Grace-window in-place retries are bounded to ONE per request (see
    // chatSurface for rationale): a second same-channel retry rarely helps.
    let graceRetriedOnce = false;
    while (true) {
      if (retryCount > maxRetries && !recoveryPass) {
        if (allFailuresRecovering && config.proxyFailoverBackoffMs > 0) {
          // One recovery pass: clear exclusions so the previously-good channel
          // can be re-selected, wait for the recovery window, then retry. Keep
          // retryCount non-zero so selection does NOT trigger the expensive
          // first-attempt route refresh against every upstream.
          recoveryPass = true;
          excludeChannelIds.length = 0;
          // Recovery: prefer the last-success channel (the one that was working
          // before transient failures started) instead of a weighted-random
          // re-select which may pick another failing site.
          const lsChannelId = proxyChannelCoordinator.getLastSuccessChannelId({
            requestedModel,
            downstreamApiKeyId,
          });
          if (lsChannelId) {
            const lsSelected = await tokenRouter.selectPreferredChannel(
              requestedModel, lsChannelId, downstreamPolicy, [],
            );
            if (lsSelected) {
              inPlaceRetryChannel = lsSelected;
            }
          }
          await sleepMs(config.proxyFailoverBackoffMs);
          continue;
        }
        break;
      }
      const stickyPreferredChannelId = !inPlaceRetryChannel && retryCount === 0
        ? getSurfaceStickyPreferredChannelId(stickySessionKey)
        : null;
      const selected: Awaited<ReturnType<typeof tokenRouter.selectChannel>> = inPlaceRetryChannel ?? await selectSurfaceChannelForAttempt({
        requestedModel,
        downstreamPolicy,
        excludeChannelIds,
        retryCount,
        stickySessionKey,
        forcedChannelId,
        downstreamApiKeyId,
      });
      inPlaceRetryChannel = null;

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
      const codexSessionId = isCodexSite
        ? getCodexSessionHeaderValue(request.headers as Record<string, string>)
        : '';
      const codexSessionStoreKey = (
        isCodexSite
        && codexSessionId
      )
        ? buildCodexSessionResponseStoreKey({
          sessionId: codexSessionId,
          siteId: selected.site.id,
          accountId: selected.account.id,
          channelId: selected.channel.id,
        })
        : '';
      const owner = getProxyResourceOwner(request);
      let normalizedResponsesBody: Record<string, unknown> = {
        ...requestEnvelope.parsed.normalizedBody,
        model: modelName,
        stream: isStream,
      };
      const serviceTierPolicy = applyOpenAiServiceTierPolicy({
        body: normalizedResponsesBody,
        context: {
          requestedModel,
          actualModel: modelName,
          sitePlatform: selected.site.platform,
          accountType: oauth?.planType,
        },
        rules: config.openAiServiceTierRules,
      });
      if (!serviceTierPolicy.ok) {
        await finalizeDebugFailure(serviceTierPolicy.statusCode, serviceTierPolicy.payload, null);
        return reply.code(serviceTierPolicy.statusCode).send(serviceTierPolicy.payload);
      }
      normalizedResponsesBody = serviceTierPolicy.body;
      if (body.generate === false) {
        normalizedResponsesBody.generate = false;
      }
      if (owner) {
        try {
          normalizedResponsesBody = await resolveResponsesBodyInputFiles(normalizedResponsesBody, owner);
        } catch (error) {
          if (error instanceof ProxyInputFileResolutionError) {
            return reply.code(error.statusCode).send(error.payload);
          }
          throw error;
        }
      }
      const openAiBody = openAiResponsesTransformer.inbound.toOpenAiBody(
        normalizedResponsesBody,
        modelName,
        isStream,
        { defaultEncryptedReasoningInclude },
      );
      const conversationFileSummary = summarizeConversationFileInputsInOpenAiBody(openAiBody);
      const hasNonImageFileInput = conversationFileSummary.hasDocument;
      const prefersNativeResponsesReasoning = wantsNativeResponsesReasoning(normalizedResponsesBody);
      const responsesConversationFileSummary = summarizeConversationFileInputsInResponsesBody(normalizedResponsesBody);
      const requiresNativeResponsesFileUrl = responsesConversationFileSummary.hasRemoteDocumentUrl
        || carriesResponsesFileUrlInput(normalizedResponsesBody.input);
      const endpointCandidates: UpstreamEndpoint[] = isCompactRequest
        ? await resolveUpstreamEndpointCandidates(
          {
            site: selected.site,
            account: selected.account,
          },
          modelName,
          'responses',
          requestedModel,
          {
            hasNonImageFileInput,
            conversationFileSummary,
            wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
          },
          {
            requestKind: 'responses-compact',
            requiresNativeResponsesFileUrl,
          },
        )
        : await resolveUpstreamEndpointCandidates(
          {
            site: selected.site,
            account: selected.account,
          },
          modelName,
          'responses',
          requestedModel,
          {
            hasNonImageFileInput,
            conversationFileSummary,
            wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
          },
          {
            requiresNativeResponsesFileUrl,
          },
        );
      const endpointRuntimeContext = {
        siteId: selected.site.id,
        modelName,
        downstreamFormat: 'responses' as const,
        requestedModelHint: requestedModel,
        requestCapabilities: {
          hasNonImageFileInput,
          conversationFileSummary,
          wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
        },
      };
      await safeUpdateSurfaceProxyDebugCandidates(debugTrace, {
        endpointCandidates,
        endpointRuntimeState: getUpstreamEndpointRuntimeStateSnapshot(endpointRuntimeContext),
        decisionSummary: {
          retryCount,
          downstreamFormat: 'responses',
          stickySessionKey,
          stickyPreferredChannelId,
          oauthProvider: oauth?.provider || null,
          isCodexSite,
          requiresNativeResponsesFileUrl,
          isCompactRequest,
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
          isCompactRequest,
        });
        const buildEndpointRequest = (endpoint: 'chat' | 'messages' | 'responses') => {
          const upstreamStream = isStream || (forceResponsesUpstreamStream && endpoint === 'responses');
          const responsesOriginalBody = (
            endpoint === 'responses'
            && isCodexSite
            && codexSessionStoreKey
            && shouldInferResponsesPreviousResponseId(
              normalizedResponsesBody,
              getCodexSessionResponseId(codexSessionStoreKey),
            )
          )
            ? withResponsesPreviousResponseId(
              normalizedResponsesBody,
              getCodexSessionResponseId(codexSessionStoreKey)!,
            )
            : normalizedResponsesBody;
          const endpointRequest = buildUpstreamEndpointRequest({
            endpoint,
            modelName,
            stream: upstreamStream,
            tokenValue: selected.tokenValue,
            oauthProvider: oauth?.provider,
            oauthProjectId: oauth?.projectId,
            sitePlatform: selected.site.platform,
            siteUrl: siteApiBaseUrl,
            openaiBody: openAiBody,
            downstreamFormat: 'responses',
            responsesOriginalBody,
            downstreamHeaders: request.headers as Record<string, unknown>,
            providerHeaders: buildProviderHeaders(),
            codexExplicitSessionId: codexSessionId || null,
          });
          const upstreamPath = (
            isCompactRequest && endpoint === 'responses'
              ? `${endpointRequest.path}/compact`
              : endpointRequest.path
          );
          const requestBody = (
            isCompactRequest && endpoint === 'responses'
              ? sanitizeCompactResponsesRequestBody(endpointRequest.body as Record<string, unknown>, {
                sitePlatform: selected.site.platform,
              })
              : endpointRequest.body as Record<string, unknown>
          );
          const requestHeaders = (
            isCompactRequest && endpoint === 'responses'
              ? ensureCompactResponsesJsonAcceptHeader(endpointRequest.headers, {
                sitePlatform: selected.site.platform,
              })
              : endpointRequest.headers
          );
          return {
            endpoint,
            path: upstreamPath,
            headers: requestHeaders,
            body: requestBody,
            runtime: endpointRequest.runtime,
          };
        };
        const baseDispatchRequest = createSurfaceDispatchRequest({
          site: selected.site,
          siteUrl: siteApiBaseUrl,
          accountExtraConfig: selected.account.extraConfig,
        });
        const dispatchRequest = (
          endpointRequest: BuiltEndpointRequest,
          targetUrl?: string,
        ) => {
          if (!isCodexSite || !endpointRequest.path.startsWith('/responses')) {
            return baseDispatchRequest(endpointRequest, targetUrl);
          }
          const sessionId = getCodexSessionHeaderValue(endpointRequest.headers);
          return runCodexHttpSessionTask(
            codexSessionStoreKey || sessionId,
            () => baseDispatchRequest(endpointRequest, targetUrl),
          );
        };
        const endpointStrategy = openAiResponsesTransformer.compatibility.createEndpointStrategy({
          isStream: isStream || forceResponsesUpstreamStream,
          requiresNativeResponsesFileUrl,
          sitePlatform: selected.site.platform,
          dispatchRequest,
        });
        const tryRecover = async (ctx: Parameters<NonNullable<typeof endpointStrategy.tryRecover>>[0]) => {
          if (oauth && shouldRefreshOauthResponsesRequest({
            oauthProvider: oauth.provider,
            status: ctx.response.status,
            response: ctx.response,
            rawErrText: ctx.rawErrText || '',
          })) {
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
          if (
            ctx.request.endpoint === 'responses'
            && isResponsesPreviousResponseNotFoundError({
              rawErrText: ctx.rawErrText,
            })
          ) {
            if (codexSessionStoreKey) {
              clearCodexSessionResponseId(codexSessionStoreKey);
            }
            const previousResponseRecovery = stripResponsesPreviousResponseId(ctx.request.body);
            if (previousResponseRecovery.removed) {
              const recoveredRequest = {
                ...ctx.request,
                body: previousResponseRecovery.body,
              };
              const recoveredResponse = await dispatchRequest(recoveredRequest, ctx.targetUrl);
              if (recoveredResponse.ok) {
                return {
                  upstream: recoveredResponse,
                  upstreamPath: recoveredRequest.path,
                  request: recoveredRequest,
                  targetUrl: ctx.targetUrl,
                };
              }
              ctx.request = recoveredRequest;
              ctx.response = recoveredResponse;
              ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
            }
          }
          const compactFallbackEnabled = config.responsesCompactFallbackToResponsesEnabled;
          if (
            isCompactRequest
            && compactFallbackEnabled
            && ctx.request.endpoint === 'responses'
            && ctx.request.path.endsWith('/responses/compact')
            && shouldFallbackCompactResponsesToResponses({
              status: ctx.response.status,
              rawErrText: ctx.rawErrText,
              requestPath: ctx.request.path,
            })
          ) {
            const normalizedSitePlatform = String(selected.site.platform || '').trim().toLowerCase();
            const recoveredUpstreamStream = shouldForceResponsesUpstreamStream({
              sitePlatform: selected.site.platform,
              isCompactRequest: false,
            });
            const recoveredHeaders = { ...ctx.request.headers } as Record<string, string>;
            delete (recoveredHeaders as Record<string, unknown>).Accept;
            if (recoveredUpstreamStream) {
              recoveredHeaders.accept = 'text/event-stream';
            }
            const recoveredBody = isRecord(ctx.request.body)
              ? { ...ctx.request.body }
              : ctx.request.body;
            if (isRecord(recoveredBody)) {
              if (recoveredUpstreamStream) {
                recoveredBody.stream = true;
              }
              if (normalizedSitePlatform === 'codex' || normalizedSitePlatform === 'sub2api') {
                recoveredBody.store = false;
              }
            }
            const recoveredRequest = {
              ...ctx.request,
              path: ctx.request.path.replace(/\/compact$/, ''),
              headers: recoveredHeaders,
              body: recoveredBody,
            };
            const recoveredResponse = await dispatchRequest(recoveredRequest);
            if (recoveredResponse.ok) {
              return {
                upstream: recoveredResponse,
                upstreamPath: recoveredRequest.path,
                request: recoveredRequest,
              };
            }
            ctx.request = recoveredRequest;
            ctx.response = recoveredResponse;
            ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
          }
          return endpointStrategy.tryRecover(ctx);
        };

        const debugAttemptBase = reserveSurfaceProxyDebugAttemptBase(debugTrace, endpointCandidates.length);
        return executeEndpointFlow({
          siteUrl: siteApiBaseUrl,
          paramOverride: selected.site.paramOverride ?? null,
          disableCrossProtocolFallback: isCompactRequest || config.disableCrossProtocolFallback,
          firstByteTimeoutMs: resolveProxyChannelFirstByteTimeoutMs(retryCount),
          endpointCandidates,
          buildRequest: (endpoint) => buildEndpointRequest(endpoint),
          dispatchRequest,
          tryRecover,
          shouldAbortRemainingEndpoints: (ctx) => shouldAbortSameSiteEndpointFallback(
            ctx.response.status,
            ctx.rawErrText || ctx.errText,
          ),
          onAttemptFailure: async (ctx) => {
            const memoryWrite = isCompactRequest
              ? null
              : recordUpstreamEndpointFailure({
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
            const memoryWrite = isCompactRequest
              ? null
              : recordUpstreamEndpointSuccess({
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

      const startTime = Date.now();
      const leaseResult = await acquireSurfaceChannelLease({
        stickySessionKey,
        selected,
            });
      if (leaseResult.status === 'timeout') {
        clearSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
            // Failure invalidates last-success affinity for this channel.
            proxyChannelCoordinator.clearLastSuccessChannel({
              requestedModel,
              downstreamApiKeyId,
              channelId: selected.channel.id,
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
      if (
        canFailoverToNextChannel(reply)
        && retryCount < maxRetries
        && canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })
      ) {
        retryCount += 1;
        continue;
      }
        await finalizeDebugFailure(503, {
          error: {
            message: busyMessage,
            type: 'server_error',
          },
        });
        sendReplyIfWritable(reply, 503, {
          error: {
            message: busyMessage,
            type: 'server_error',
          },
        });
        return;
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
        const finalizeStreamSuccess = async (
          parsedUsage: UsageSummary,
          latency: number,
          streamDebugBody: unknown,
          upstreamUsagePresent: boolean,
        ) => {
          try {
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
              latencyMs: latency,
              retryCount,
              upstreamPath: successfulUpstreamPath,
              logSuccess: failureToolkit.log,
              recordDownstreamCost: (estimatedCost) => {
                recordDownstreamCostUsage(request, estimatedCost);
              },
              bestEffortMetrics: {
                errorLabel: '[responses] post-stream bookkeeping failed:',
              },
            });
          } catch (error) {
            console.error('[responses] post-stream success logging failed:', error);
          }
          await finalizeDebugSuccess(
            200,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            streamDebugBody,
          );
        };

        if (isStream) {
          const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
          let streamStarted = false;
          const startSseResponse = () => {
            if (streamStarted) return;
            if (isFastifyReplyCommitted(reply)) {
              streamStarted = true;
              return;
            }
            streamStarted = true;
            reply.hijack();
            reply.raw.statusCode = 200;
            reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Accel-Buffering', 'no');
          };

          let parsedUsage: UsageSummary = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            promptTokensIncludeCache: null,
          };
          let upstreamUsagePresent = false;
          const writeLines = (lines: string[]) => {
            for (const line of lines) reply.raw.write(line);
          };
          const websocketTransportRequest = isResponsesWebsocketTransportRequest(request.headers as Record<string, unknown>);
          const streamSession = openAiResponsesTransformer.proxyStream.createSession({
            modelName,
            successfulUpstreamPath,
            getUsage: () => parsedUsage,
            onParsedPayload: (payload) => {
              if (payload && typeof payload === 'object') {
                upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(payload);
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(payload));
                if (codexSessionStoreKey) {
                  rememberCodexSessionResponseId(codexSessionStoreKey, payload);
                }
              }
            },
            writeLines,
            writeRaw: (chunk) => {
              reply.raw.write(chunk);
            },
          });
          if (!upstreamContentType.includes('text/event-stream')) {
            const rawText = await readRuntimeResponseText(upstream);
            if (looksLikeResponsesSseText(rawText)) {
              startSseResponse();
              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(rawText),
                reply.raw,
              );
              const latency = Date.now() - startTime;
	              if (streamResult.status === 'failed') {
	                clearSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
            // Failure invalidates last-success affinity for this channel.
            proxyChannelCoordinator.clearLastSuccessChannel({
              requestedModel,
              downstreamApiKeyId,
              channelId: selected.channel.id,
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
                return;
	              }

	              await finalizeStreamSuccess(
                  parsedUsage,
                  latency,
                  debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
                  upstreamUsagePresent,
                );
	              bindSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
	              return;
	            }
            let upstreamData: unknown = rawText;
            try {
              upstreamData = JSON.parse(rawText);
            } catch {
              upstreamData = rawText;
            }
            if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
              upstreamData = unwrapGeminiCliPayload(upstreamData);
            }
            if (codexSessionStoreKey) {
              rememberCodexSessionResponseId(codexSessionStoreKey, upstreamData);
            }

            parsedUsage = parseProxyUsage(upstreamData);
            upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(upstreamData);
            const latency = Date.now() - startTime;
            const failure = detectProxyFailure({ rawText, usage: parsedUsage });
	            if (failure) {
	              clearSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
            // Failure invalidates last-success affinity for this channel.
            proxyChannelCoordinator.clearLastSuccessChannel({
              requestedModel,
              downstreamApiKeyId,
              channelId: selected.channel.id,
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
	              const inPlaceRecoveringRetry = !canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })
	                && canRetryInPlaceForRecoveringFailure(retryCount, failure.status, failure.reason, config.proxyFailoverBackoffMs);
	              const terminalFailureOutcome = failureOutcome.action === 'retry'
	                ? (
	                  canFailoverToNextChannel(reply)
	                  && (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs }) || inPlaceRecoveringRetry)
	                    ? null
	                    : finalizeRetryAsUpstreamFailure(failure.status, failure.reason)
	                )
	                : failureOutcome;
	              if (!terminalFailureOutcome) {
	                if (!isRecoveringTransientFailure(failure.status, failure.reason)) {
	                  allFailuresRecovering = false;
	                }
	                // Grace window: stay on the same channel for a configurable grace
	                // period on transient-recovering failures (WAF/429/5xx) before
	                // failing over, so the upstream gets a chance to self-heal.
	                if (!graceRetriedOnce && shouldGraceRetryInPlace(Date.now() - requestStartedAtMs, config.proxyRecoveringGraceMs, failure.status, failure.reason)) {
                graceRetriedOnce = true;
	                  inPlaceRetryChannel = selected;
	                  await sleepMs(resolveFailoverBackoffMs(failure.status, failure.reason, config.proxyFailoverBackoffMs));
	                  continue;
	                }
	                if (inPlaceRecoveringRetry) {
	                  inPlaceRetryChannel = selected;
	                  await sleepMs(resolveFailoverBackoffMs(failure.status, failure.reason, config.proxyFailoverBackoffMs));
	                  continue;
	                }
	                if (failureOutcome.action === 'retry') {
	                  await appendExcludedSiteChannels(failureOutcome.excludeSiteId);
	                }
	                await sleepMs(resolveFailoverBackoffMs(failure.status, failure.reason, config.proxyFailoverBackoffMs));
	                retryCount += 1;
	                continue;
	              }
	              await finalizeDebugFailure(
	                terminalFailureOutcome.status,
	                terminalFailureOutcome.payload,
	                successfulUpstreamPath,
	              );
	              sendReplyIfWritable(reply, terminalFailureOutcome.status, terminalFailureOutcome.payload);
	              return;
            }

            startSseResponse();
            const streamResult = streamSession.consumeUpstreamFinalPayload(upstreamData, rawText, reply.raw);
	            if (streamResult.status === 'failed') {
	              clearSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
            // Failure invalidates last-success affinity for this channel.
            proxyChannelCoordinator.clearLastSuccessChannel({
              requestedModel,
              downstreamApiKeyId,
              channelId: selected.channel.id,
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
              return;
	            }

	            await finalizeStreamSuccess(
                parsedUsage,
                latency,
                debugTrace?.options.captureStreamChunks ? rawText : upstreamData,
                upstreamUsagePresent,
              );
	            bindSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
	            return;
	          }

          startSseResponse();

          let replayReader: ReturnType<typeof createSingleChunkStreamReader> | null = null;
          if (websocketTransportRequest) {
            const rawText = await readRuntimeResponseText(upstream);
            if (looksLikeResponsesSseText(rawText)) {
              try {
                const collectedPayload = collectResponsesFinalPayloadFromSseText(rawText, modelName).payload;
                upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(collectedPayload);
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(collectedPayload));
                const createdPayload = {
                  ...collectedPayload,
                  status: 'in_progress',
                  output: [],
                  output_text: '',
                };
                const terminalEventType = String(collectedPayload.status || '').trim().toLowerCase() === 'incomplete'
                  ? 'response.incomplete'
                  : 'response.completed';
                writeLines([
                  `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: createdPayload })}\n\n`,
                  `event: ${terminalEventType}\ndata: ${JSON.stringify({ type: terminalEventType, response: collectedPayload })}\n\n`,
                  'data: [DONE]\n\n',
                ]);
                if (codexSessionStoreKey) {
                  rememberCodexSessionResponseId(codexSessionStoreKey, collectedPayload);
                }
                reply.raw.end();
                const latency = Date.now() - startTime;
                await finalizeStreamSuccess(
                  parsedUsage,
                  latency,
                  debugTrace?.options.captureStreamChunks ? rawText : collectedPayload,
                  upstreamUsagePresent,
                );
                bindSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
                return;
              } catch {
                // Fall through to the generic stream session for response.failed/error terminals.
              }

              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(rawText),
                reply.raw,
              );
              const latency = Date.now() - startTime;
              if (streamResult.status === 'failed') {
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
                return;
              }

              await finalizeStreamSuccess(
                parsedUsage,
                latency,
                debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
                upstreamUsagePresent,
              );
              return;
            }

            replayReader = createSingleChunkStreamReader(rawText);
          }

          const upstreamReader = replayReader ?? getRuntimeResponseReader(upstream);
          const baseReader = String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli' && upstreamReader
            ? createGeminiCliStreamReader(upstreamReader)
            : upstreamReader;
          let rawText = '';
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
          const unwireStreamCancel = wireStreamCancelOnClientDisconnect(
            reply,
            () => (reader ? () => reader.cancel('client disconnected') : null),
          );
          const streamResult = await streamSession.run(reader, reply.raw);
          unwireStreamCancel();
          rawText += decoder.decode();

          const latency = Date.now() - startTime;
	          if (streamResult.status === 'failed') {
	            clearSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
            // Failure invalidates last-success affinity for this channel.
            proxyChannelCoordinator.clearLastSuccessChannel({
              requestedModel,
              downstreamApiKeyId,
              channelId: selected.channel.id,
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
            return;
          }

          // Once SSE has been hijacked and bytes may already be on the wire, we
          // must not attempt to convert stream failures into a fresh HTTP error
          // response or retry on another channel. Responses stream failures are
	          // handled in-band by the proxy stream session.

	          await finalizeStreamSuccess(
              parsedUsage,
              latency,
              debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
              upstreamUsagePresent,
            );
	          bindSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
	          return;
	        }

        const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
        let rawText = '';
        let upstreamData: unknown;
        if (
          upstreamContentType.includes('text/event-stream')
          && (
            successfulUpstreamPath.endsWith('/responses')
            || successfulUpstreamPath.endsWith('/responses/compact')
          )
        ) {
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
        if (codexSessionStoreKey) {
          rememberCodexSessionResponseId(codexSessionStoreKey, upstreamData);
        }
        const latency = Date.now() - startTime;
        const parsedUsage = parseProxyUsage(upstreamData);
        const upstreamUsagePresent = hasProxyUsagePayload(upstreamData);
        const failure = detectProxyFailure({ rawText, usage: parsedUsage });
	        if (failure) {
	          clearSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
            // Failure invalidates last-success affinity for this channel.
            proxyChannelCoordinator.clearLastSuccessChannel({
              requestedModel,
              downstreamApiKeyId,
              channelId: selected.channel.id,
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
	          const inPlaceRecoveringRetry = !canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })
	            && canRetryInPlaceForRecoveringFailure(retryCount, failure.status, failure.reason, config.proxyFailoverBackoffMs);
	          const terminalFailureOutcome = failureOutcome.action === 'retry'
	            ? (
	              canFailoverToNextChannel(reply)
	              && (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs }) || inPlaceRecoveringRetry)
	                ? null
	                : finalizeRetryAsUpstreamFailure(failure.status, failure.reason)
	            )
	            : failureOutcome;
	          if (!terminalFailureOutcome) {
	            if (!isRecoveringTransientFailure(failure.status, failure.reason)) {
	              allFailuresRecovering = false;
	            }
	            // Grace window: stay on the same channel for a configurable grace
	            // period on transient-recovering failures (WAF/429/5xx) before
	            // failing over, so the upstream gets a chance to self-heal.
	            if (!graceRetriedOnce && shouldGraceRetryInPlace(Date.now() - requestStartedAtMs, config.proxyRecoveringGraceMs, failure.status, failure.reason)) {
                graceRetriedOnce = true;
	              inPlaceRetryChannel = selected;
	              await sleepMs(resolveFailoverBackoffMs(failure.status, failure.reason, config.proxyFailoverBackoffMs));
	              continue;
	            }
	            if (inPlaceRecoveringRetry) {
	              inPlaceRetryChannel = selected;
	              await sleepMs(resolveFailoverBackoffMs(failure.status, failure.reason, config.proxyFailoverBackoffMs));
	              continue;
	            }
	            if (failureOutcome.action === 'retry') {
	              await appendExcludedSiteChannels(failureOutcome.excludeSiteId);
	            }
	            await sleepMs(resolveFailoverBackoffMs(failure.status, failure.reason, config.proxyFailoverBackoffMs));
	            retryCount += 1;
	            continue;
	          }
	          await finalizeDebugFailure(
	            terminalFailureOutcome.status,
	            terminalFailureOutcome.payload,
	            successfulUpstreamPath,
	          );
	          sendReplyIfWritable(reply, terminalFailureOutcome.status, terminalFailureOutcome.payload);
	          return;
        }
        const normalized = openAiResponsesTransformer.transformFinalResponse(
          upstreamData,
          modelName,
          rawText,
        );
        const downstreamData = openAiResponsesTransformer.outbound.serializeFinal({
          upstreamPayload: upstreamData,
          normalized,
          usage: parsedUsage,
          serializationMode: isCompactRequest ? 'compact' : 'response',
        });
        try {
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
              errorLabel: '[responses] post-response bookkeeping failed:',
            },
          });
	        } catch (error) {
	          console.error('[responses] post-response success logging failed:', error);
	        }
	        await finalizeDebugSuccess(
            upstream.status,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            downstreamData,
          );
	        bindSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
	        return reply.send(downstreamData);
	      } catch (err: any) {
	        clearSurfaceStickyChannel({
            stickySessionKey,
            selected,
            requestedModel,
            downstreamApiKeyId,
          });
            // Failure invalidates last-success affinity for this channel.
            proxyChannelCoordinator.clearLastSuccessChannel({
              requestedModel,
              downstreamApiKeyId,
              channelId: selected.channel.id,
            });
          const endpointFailureStatus = typeof err?.status === 'number' ? err.status : null;
          const isSiteApiEndpointFailure = (
            err instanceof SiteApiEndpointRequestError
            || err?.name === 'SiteApiEndpointRequestError'
            || err?.siteApiEndpointUpstreamFailure === true
            || (endpointFailureStatus !== null && endpointFailureStatus >= 500)
          );
          if (isSiteApiEndpointFailure) {
            const failureOutcome = await failureToolkit.handleUpstreamFailure({
              selected,
            requestedModel,
          modelName,
          status: endpointFailureStatus || 502,
          errText: err?.message || 'unknown error',
          rawErrText: err?.rawErrText || err?.message || 'unknown error',
          isStream,
          latencyMs: Date.now() - startTime,
          retryCount,
        });
            const inPlaceRecoveringRetry = !canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })
              && canRetryInPlaceForRecoveringFailure(retryCount, endpointFailureStatus || 502, err?.message || null, config.proxyFailoverBackoffMs);
            const terminalFailureOutcome = failureOutcome.action === 'retry'
              ? (
                canFailoverToNextChannel(reply)
                && (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs }) || inPlaceRecoveringRetry)
                  ? null
                  : finalizeRetryAsUpstreamFailure(endpointFailureStatus || 502, err?.message || 'unknown error')
              )
              : failureOutcome;
            if (!terminalFailureOutcome) {
              if (!isRecoveringTransientFailure(endpointFailureStatus || 502, err?.message || null)) {
                allFailuresRecovering = false;
              }
              // Grace window: stay on the same channel for a configurable grace
              // period on transient-recovering failures (WAF/429/5xx) before
              // failing over, so the upstream gets a chance to self-heal.
              if (!graceRetriedOnce && shouldGraceRetryInPlace(Date.now() - requestStartedAtMs, config.proxyRecoveringGraceMs, endpointFailureStatus || 502, err?.message || null)) {
                graceRetriedOnce = true;
                inPlaceRetryChannel = selected;
                await sleepMs(resolveFailoverBackoffMs(endpointFailureStatus || 502, err?.message || null, config.proxyFailoverBackoffMs));
                continue;
              }
              if (inPlaceRecoveringRetry) {
                inPlaceRetryChannel = selected;
                await sleepMs(resolveFailoverBackoffMs(endpointFailureStatus || 502, err?.message || null, config.proxyFailoverBackoffMs));
                continue;
              }
              if (failureOutcome.action === 'retry') {
                await appendExcludedSiteChannels(failureOutcome.excludeSiteId);
              }
              await sleepMs(resolveFailoverBackoffMs(endpointFailureStatus || 502, err?.message || null, config.proxyFailoverBackoffMs));
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
          const inPlaceRecoveringRetry = !canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs })
            && canRetryInPlaceForRecoveringFailure(retryCount, 502, err?.message || null, config.proxyFailoverBackoffMs);
          const terminalFailureOutcome = failureOutcome.action === 'retry'
            ? (
              canFailoverToNextChannel(reply)
              && (canRetryChannelSelection(retryCount, forcedChannelId, Date.now() - requestStartedAtMs, { maxRetries, budgetMs: failoverBudgetMs }) || inPlaceRecoveringRetry)
                ? null
                : finalizeRetryAsExecutionFailure(err?.message || 'network failure')
            )
            : failureOutcome;
          if (!terminalFailureOutcome) {
            if (!isRecoveringTransientFailure(502, err?.message || null)) {
              allFailuresRecovering = false;
            }
            // Grace window: stay on the same channel for a configurable grace
            // period on transient-recovering failures (WAF/429/5xx) before
            // failing over, so the upstream gets a chance to self-heal.
            if (!graceRetriedOnce && shouldGraceRetryInPlace(Date.now() - requestStartedAtMs, config.proxyRecoveringGraceMs, 502, err?.message || null)) {
                graceRetriedOnce = true;
              inPlaceRetryChannel = selected;
              await sleepMs(resolveFailoverBackoffMs(502, err?.message || null, config.proxyFailoverBackoffMs));
              continue;
            }
            if (inPlaceRecoveringRetry) {
              inPlaceRetryChannel = selected;
              await sleepMs(resolveFailoverBackoffMs(502, err?.message || null, config.proxyFailoverBackoffMs));
              continue;
            }
            if (failureOutcome.action === 'retry') {
              await appendExcludedSiteChannels(failureOutcome.excludeSiteId);
            }
            await sleepMs(resolveFailoverBackoffMs(502, err?.message || null, config.proxyFailoverBackoffMs));
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
