import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { buildOauthProviderHeaders } from './oauth/service.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from './siteProxy.js';
import { dispatchRuntimeRequest } from './runtimeDispatch.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpointRuntime.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../proxy-core/orchestration/endpointFlow.js';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';
import { isEndpointDowngradeError } from '../transformers/shared/endpointCompatibility.js';
import { shouldAbortSameSiteEndpointFallback } from './proxyRetryPolicy.js';
import { resolveProxyChannelFirstByteTimeoutMs } from './proxyChannelRetry.js';
import type { schema } from '../db/index.js';
import { getRandomProbeQuestion, type ProbeQuestion } from './probeQuestionBank.js';
import { db } from '../db/index.js';
import { probeLogs } from '../db/schema.js';

export type RuntimeModelProbeStatus = 'supported' | 'unsupported' | 'inconclusive' | 'skipped';

export type RuntimeModelProbeResult = {
  status: RuntimeModelProbeStatus;
  latencyMs: number | null;
  reason: string;
};

const NON_CONVERSATION_MODEL_PATTERNS = [
  /(^|[-_/])embedding(s)?($|[-_/])/i,
  /(^|[-_/])rerank($|[-_/])/i,
  /(^|[-_/])moderation($|[-_/])/i,
  /(^|[-_/])whisper($|[-_/])/i,
  /(^|[-_/])tts($|[-_/])/i,
  /(^|[-_/])transcribe|transcription/i,
  /(^|[-_/])dall-e($|[-_/])/i,
  /(^|[-_/])imagen($|[-_/])/i,
  /(^|[-_/])veo($|[-_/])/i,
  /(^|[-_/])cogvideo($|[-_/])/i,
];

const DEFINITE_UNSUPPORTED_PATTERNS = [
  /no such model/i,
  /unknown model/i,
  /unsupported model/i,
  /invalid model/i,
  /model[^]{0,80}(does not exist|not found|not available|unavailable|unsupported|invalid|disabled)/i,
  /(does not exist|not found|not available|unavailable|unsupported|invalid|disabled)[^]{0,40}model/i,
  /模型[^]{0,40}(不存在|不可用|不支持|无效|禁用|未开通|未开放)/,
  /(不存在|不可用|不支持|无效|禁用)[^]{0,20}模型/,
  /model[^]{0,80}(access denied|permission|forbidden|not allowed)/i,
  /模型[^]{0,40}(无权限|未授权|禁止访问)/,
];

function isLikelyConversationModel(modelName: string): boolean {
  const normalized = String(modelName || '').trim();
  if (!normalized) return false;
  if (normalized.startsWith('__')) return false;
  return !NON_CONVERSATION_MODEL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function classifyUnsupportedFailure(status: number, rawErrorText: string): boolean {
  if (![400, 403, 404, 422].includes(status)) return false;
  const normalized = String(rawErrorText || '').trim();
  if (!normalized) return false;
  return DEFINITE_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Failures returned by a relay can describe its downstream model channel rather
 * than the MetAPI account credential. Keep that distinction explicit for the
 * marketplace so a healthy account is not presented as expired or broken.
 */
export function classifyProbeFailureReason(status: number, rawErrorText: string): string {
  const text = String(rawErrorText || '').trim();
  const lower = text.toLowerCase();
  const isChannelAuthFailure = (
    lower.includes('authorization failed')
    || lower.includes('model authorization failed')
    || (lower.includes('bad_response_status_code') && lower.includes('authorization'))
  );
  if (isChannelAuthFailure) {
    return `上游模型渠道鉴权失败（不是 MetAPI 账户凭证失效）：${text}`;
  }

  const isModelChannelUnavailable = (
    status === 404
    || lower.includes('model not found')
    || lower.includes('model_not_found')
    || lower.includes('no available channel')
    || lower.includes('当前模型暂不可用')
    || lower.includes('openai_error')
  );
  if (isModelChannelUnavailable) {
    return `上游模型渠道不可用（本站其他模型可能仍正常）：${text || `HTTP ${status}`}`;
  }
  return text || `probe failed with status ${status || 0}`;
}

/**
 * Some upstream relays (one-api/new-api) classify requests whose total prompt
 * length falls below ~500 tokens as health-check probes and answer with a
 * stub or fixed-price billing. Inject a short background passage as the system
 * message so the probe prompt reliably clears the threshold and is handled as
 * a normal conversation.
 */
const PROBE_CONTEXT_PADDING = `
Large language models are trained to predict the next token in a sequence from massive corpora of text, and they have become capable of answering questions, writing code, summarizing documents, and following detailed instructions. The Transformer architecture that underpins these models relies on self-attention, which lets every token in the input attend to every other token, so the model can build rich contextual representations regardless of distance. Pre-training on web text, books, and code gives the model broad world knowledge, while instruction tuning and preference optimization align its behavior with what users expect: clear, helpful, and well-structured answers. Inference servers expose this capability through OpenAI-compatible APIs, where a client sends a list of messages with roles such as system, user, and assistant, and the model generates a completion in response. System messages set the overall behavior and constraints for the conversation, user messages carry the actual request, and assistant messages hold prior model output. The generation process is autoregressive: the model produces one token at a time, feeding its own output back as input, until it reaches a stop condition or the configured token budget. Sampling parameters such as temperature and top-p control the randomness of the output, and max_tokens bounds the length of the completion. Streaming delivers partial tokens as they are generated using server-sent events, which improves perceived latency for long answers. For evaluation, a probe request sends a modest question and checks that the response is coherent and that token usage is reported, which confirms the endpoint is genuinely serving the model rather than returning an error or a stub. In practice, the same request format is used by thousands of applications, from simple chat widgets to complex agent pipelines that chain multiple model calls together, and the API contract stays stable regardless of the payload size or the model being invoked. Please answer the user message below clearly and completely, in the same language as the question, and include any reasoning steps that are relevant to the answer.
`;

export function buildRuntimeProbeChatBody(
  modelName: string,
  questionText: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelName,
    messages: [
      {
        role: 'system',
        content: PROBE_CONTEXT_PADDING,
      },
      { role: 'user', content: questionText },
    ],
    stream: false,
  };
  return body;
}

function buildProbeBody(modelName: string): { body: Record<string, unknown>, question: ProbeQuestion } {
  const question = getRandomProbeQuestion();
  return { body: buildRuntimeProbeChatBody(modelName, question.question), question };
}

/**
 * 从 OpenAI 格式的响应中提取 token 使用量
 */
function extractTokensFromResponse(responseText: string | undefined): number | null {
  if (!responseText) return null;
  try {
    const response = JSON.parse(responseText);
    if (response.usage && typeof response.usage.total_tokens === 'number') {
      return response.usage.total_tokens;
    }
  } catch {
    // 解析失败，返回 null
  }
  return null;
}

/**
 * 从上游响应中提取用户可见的回答正文（assistant text）。
 * 兼容 Chat Completions 与 Responses 格式，避免在 2k 截断时丢失真实答案
 * （Responses 包的 instructions/前置元数据会挤占前段空间）。
 */
function extractAssistantText(responseText: string | undefined): string | null {
  if (!responseText) return null;
  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch {
    // 非 JSON（如纯文本/二进制），截断保存
    return responseText.substring(0, 2000) || null;
  }
  if (typeof response !== 'object' || response === null) {
    return String(response).substring(0, 2000);
  }
  const r = response as Record<string, unknown>;

  // plaintext 响应（/v1/audio, embeddings 等无 content）
  const plaintext = r.plaintext ?? r.text;
  if (typeof plaintext === 'string' && plaintext.trim()) {
    return plaintext.substring(0, 2000);
  }

  // Chat Completions: choices[].message.content
  const choices = r.choices as unknown;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const message = (choice as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (typeof content === 'string' && content.trim()) return content.substring(0, 2000);
      const delta = (choice as Record<string, unknown>)?.delta as Record<string, unknown> | undefined;
      const deltaContent = delta?.content;
      if (typeof deltaContent === 'string' && deltaContent.trim()) return deltaContent.substring(0, 2000);
    }
  }

  // Responses 格式: output[] 中的 type === 'message'，取其 content 里首个非空文本
  const output = r.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const obj = item as Record<string, unknown>;
      if (obj?.type !== 'message' && obj?.role !== 'assistant') continue;
      const itemContent = obj.content;
      if (typeof itemContent === 'string' && itemContent.trim()) return itemContent.substring(0, 2000);
      if (Array.isArray(itemContent)) {
        let joined = '';
        for (const part of itemContent) {
          const p = part as Record<string, unknown>;
          const text = p?.text;
          if (typeof text === 'string') {
            joined += text;
            if (joined.trim().length >= 500) break;
          }
        }
        if (joined.trim()) return joined.substring(0, 2000);
      }
    }
  }

  // 顶层 content / text / message.content 兜底
  const topContent = r.content ?? r.text ?? r.answer;
  if (typeof topContent === 'string' && topContent.trim()) return topContent.substring(0, 2000);
  const message = r.message as Record<string, unknown> | undefined;
  if (message && typeof message.content === 'string' && message.content.trim()) {
    return message.content.substring(0, 2000);
  }

  // 未提取到正文则退回原样截断
  return responseText.substring(0, 2000) || null;
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveRemainingTimeoutMs(deadlineAtMs: number, timeoutLabel: string): number {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(timeoutLabel);
  }
  return remainingMs;
}

export async function probeRuntimeModel(input: {
  site: typeof schema.sites.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  modelName: string;
  timeoutMs: number;
  tokenValue?: string | null;
}): Promise<RuntimeModelProbeResult> {
  if (!isLikelyConversationModel(input.modelName)) {
    return {
      status: 'skipped',
      latencyMs: null,
      reason: 'skipped non-conversation model probe',
    };
  }

  const oauth = getOauthInfoFromAccount(input.account);
  // Prefer explicit tokenValue, then:
  // - OAuth accounts: accessToken (session/oauth token)
  // - API-key style: apiToken, fallback accessToken (many new-api session imports only fill accessToken)
  // Never treat empty apiToken as "no credential" when accessToken is present.
  const tokenValue = String(
    input.tokenValue
    || (oauth
      ? (input.account.accessToken || input.account.apiToken)
      : (input.account.apiToken || input.account.accessToken))
    || '',
  ).trim();
  if (!tokenValue) {
    return {
      status: 'inconclusive',
      latencyMs: null,
      reason: 'missing credential for probe',
    };
  }

  const startedAt = Date.now();
  const deadlineAtMs = startedAt + Math.max(1, input.timeoutMs);
  try {
    const endpointCandidates = await withTimeout(
      () => resolveUpstreamEndpointCandidates(
        {
          site: input.site,
          account: input.account,
        },
        input.modelName,
        'openai',
        input.modelName,
      ),
      resolveRemainingTimeoutMs(
        deadlineAtMs,
        `runtime model probe candidate resolution timeout (${Math.round(input.timeoutMs / 1000)}s)`,
      ),
      `runtime model probe candidate resolution timeout (${Math.round(input.timeoutMs / 1000)}s)`,
    );
    if (endpointCandidates.length <= 0) {
      return {
        status: 'inconclusive',
        latencyMs: Date.now() - startedAt,
        reason: 'no compatible probe endpoint candidates',
      };
    }

    const providerHeaders = buildOauthProviderHeaders({
      account: input.account,
      downstreamHeaders: {},
    });
    const { body: openaiBody, question: probeQuestion } = buildProbeBody(input.modelName);
    const channelProxyUrl = resolveChannelProxyUrl(input.site, input.account.extraConfig);
    const abortController = new AbortController();
    const remainingExecutionTimeoutMs = resolveRemainingTimeoutMs(
      deadlineAtMs,
      `runtime model probe timeout (${Math.round(input.timeoutMs / 1000)}s)`,
    );
    const abortTimer = setTimeout(() => {
      abortController.abort(new Error(`runtime model probe timeout (${Math.round(input.timeoutMs / 1000)}s)`));
    }, remainingExecutionTimeoutMs);
    abortTimer.unref?.();

    const buildRequest = (endpoint: UpstreamEndpoint): BuiltEndpointRequest => {
      const request = buildUpstreamEndpointRequest({
        endpoint,
        modelName: input.modelName,
        stream: false,
        tokenValue,
        oauthProvider: oauth?.provider,
        oauthProjectId: oauth?.projectId,
        sitePlatform: input.site.platform,
        siteUrl: input.site.url,
        openaiBody,
        downstreamFormat: 'openai',
        downstreamHeaders: {},
        providerHeaders,
      });
      return {
        endpoint,
        path: request.path,
        headers: request.headers,
        body: request.body as Record<string, unknown>,
        runtime: request.runtime,
      };
    };
    const dispatchRequest = async (
      request: BuiltEndpointRequest,
      targetUrl: string,
    ) => (
      dispatchRuntimeRequest({
        siteUrl: input.site.url,
        targetUrl,
        request,
        buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(
          input.site,
          {
            method: 'POST',
            headers: requestForFetch.headers,
            body: JSON.stringify(requestForFetch.body),
            signal: abortController.signal,
          },
          channelProxyUrl,
        ),
      })
    );

    let result: Awaited<ReturnType<typeof executeEndpointFlow>>;
    try {
      result = await executeEndpointFlow({
        siteUrl: input.site.url,
        proxyUrl: channelProxyUrl,
        paramOverride: input.site.paramOverride ?? null,
        endpointCandidates,
        buildRequest,
        dispatchRequest,
        // Same first-byte guard as live proxy surfaces: a relay site that
        // never returns a byte should fail fast instead of dragging the probe
        // to its full timeout (which made slow-but-alive sites dominate the
        // probe log as ambiguous timeouts).
        firstByteTimeoutMs: resolveProxyChannelFirstByteTimeoutMs(0),
        // Match live proxy surfaces: cascade protocols on endpoint mismatch,
        // but abort same-site cascade for WAF/5xx/model-missing style failures.
        shouldAbortRemainingEndpoints: (ctx) => shouldAbortSameSiteEndpointFallback(
          ctx.response.status,
          ctx.rawErrText,
        ),
        shouldDowngrade: (ctx) => (
          ctx.response.status >= 500
          || isEndpointDowngradeError(ctx.response.status, ctx.rawErrText)
        ),
      });
    } finally {
      clearTimeout(abortTimer);
    }
    const latencyMs = Date.now() - startedAt;

    if (result.ok) {
      const responseText = await readRuntimeResponseText(result.upstream).catch(() => undefined);
      const tokensUsed = extractTokensFromResponse(responseText);

      // 记录成功的测活日志
      await db.insert(probeLogs).values({
        siteId: input.site.id,
        accountId: input.account.id,
        modelName: input.modelName,
        questionCategory: probeQuestion.category,
        questionText: probeQuestion.question,
        responseText: extractAssistantText(responseText) || null,
        status: 'success',
        latencyMs,
        tokensUsed,
      }).catch((err: unknown) => console.error('[probe-log] Failed to insert probe log:', err));

      return {
        status: 'supported',
        latencyMs,
        reason: 'probe succeeded',
      };
    }

    const rawErrorText = String(result.rawErrText || result.errText || '').trim();
    const probeStatus = classifyUnsupportedFailure(result.status || 0, rawErrorText) ? 'unsupported' : 'inconclusive';
    const logStatus = probeStatus === 'unsupported' ? 'failed' : 'failed';
    // 记录失败的测活日志
    await db.insert(probeLogs).values({
      siteId: input.site.id,
      accountId: input.account.id,
      modelName: input.modelName,
      questionCategory: probeQuestion.category,
      questionText: probeQuestion.question,
      responseText: null,
      status: logStatus,
      latencyMs,
      tokensUsed: null,
      errorMessage: classifyProbeFailureReason(result.status || 0, rawErrorText),
    }).catch((err: unknown) => console.error('[probe-log] Failed to insert probe log:', err));

    return {
      status: probeStatus,
      latencyMs,
      reason: classifyProbeFailureReason(result.status || 0, rawErrorText),
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const errorMessage = error instanceof Error ? error.message : 'probe failed';
    const isTimeout = errorMessage.includes('timeout');

    // 记录异常的测活日志
    await db.insert(probeLogs).values({
      siteId: input.site.id,
      accountId: input.account.id,
      modelName: input.modelName,
      questionCategory: 'unknown',
      questionText: '测活请求尚未发出',
      responseText: null,
      status: isTimeout ? 'timeout' : 'failed',
      latencyMs,
      tokensUsed: null,
      errorMessage,
    }).catch((err: unknown) => console.error('[probe-log] Failed to insert probe log:', err));

    return {
      status: 'inconclusive',
      latencyMs,
      reason: errorMessage,
    };
  }
}
