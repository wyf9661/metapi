import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { buildOauthProviderHeaders } from './oauth/service.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from './siteProxy.js';
import { dispatchRuntimeRequest } from './runtimeDispatch.js';
import { requireSiteApiBaseUrl } from './siteApiEndpointService.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpointRuntime.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../proxy-core/orchestration/endpointFlow.js';
import { readRuntimeResponseText, type RuntimeResponse } from '../proxy-core/executors/types.js';
import {
  collectResponsesFinalPayloadFromSseText,
  looksLikeResponsesSseText,
} from '../proxy-core/runtime/responsesSseFinal.js';
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
    stream: true,
  };
  return body;
}

function buildProbeBody(modelName: string): { body: Record<string, unknown>, question: ProbeQuestion } {
  const question = getRandomProbeQuestion();
  return { body: buildRuntimeProbeChatBody(modelName, question.question), question };
}

/**
 * OpenAI 兼容 Chat Completions SSE（data: {...} 行，[DONE] 结尾）折叠为
 * 最小 JSON 响应（choices[0].message.content + usage），供后续提取器复用。
 * 返回 null 表示不是有效的 chat SSE。
 */
function foldChatSseToMinimalJson(text: string): string | null {
  const parts: string[] = [];
  let usage: Record<string, unknown> | undefined;
  let sawData = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      if (payload === '[DONE]') sawData = true;
      continue;
    }
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      sawData = true;
      const choice = (obj.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.content === 'string' && delta.content) {
        parts.push(delta.content);
      }
      if (obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage)) {
        usage = obj.usage as Record<string, unknown>;
      }
    } catch {
      // 忽略非 JSON 行
    }
  }
  if (!sawData) return null;
  return JSON.stringify({
    choices: [{ message: { content: parts.join('') } }],
    ...(usage ? { usage } : {}),
  });
}

/** 统一折叠测活响应文本:Responses SSE → 最终 payload;chat SSE → 最小 JSON;否则原样。 */
function foldProbeResponseText(rawText: string, modelName: string): string {
  if (looksLikeResponsesSseText(rawText)) {
    try {
      return JSON.stringify(collectResponsesFinalPayloadFromSseText(rawText, modelName).payload);
    } catch {
      return rawText;
    }
  }
  return foldChatSseToMinimalJson(rawText) ?? rawText;
}

/** 在 SSE buffer 中查找第一个携带实际内容的 data 行(增量扫描,返回相对 startedAt 的延迟 ms)。 */
function firstContentDeltaLatencyMs(buffer: string, startedAtMs: number): number | null {
  let searchFrom = 0;
  while (searchFrom < buffer.length) {
    const lineEnd = buffer.indexOf('\n', searchFrom);
    const line = lineEnd === -1 ? buffer.slice(searchFrom) : buffer.slice(searchFrom, lineEnd);
    const trimmed = line.trim();
    searchFrom = lineEnd === -1 ? buffer.length : lineEnd + 1;
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      if (obj.error) return Date.now() - startedAtMs === 0 ? 1 : Date.now() - startedAtMs;
      if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string' && obj.delta) {
        return Math.max(1, Date.now() - startedAtMs);
      }
      const choice = (obj.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      // 推理模型的 reasoning_content 也是「开始响应」的信号(content 可能长时间为 null)
      const content = delta?.content ?? delta?.text ?? delta?.reasoning_content;
      if (typeof content === 'string' && content.trim()) {
        return Math.max(1, Date.now() - startedAtMs);
      }
      if (obj.type === 'content_block_delta') {
        const blockDelta = obj.delta as Record<string, unknown> | undefined;
        if (blockDelta && typeof blockDelta.text === 'string' && blockDelta.text) {
          return Math.max(1, Date.now() - startedAtMs);
        }
      }
    } catch {
      // 忽略非 JSON 行
    }
  }
  return null;
}

/** 整体 JSON 响应(上游无视 stream:true,或单块到达的完整响应)的内容检测。 */
function firstJsonContentLatencyMs(buffer: string, startedAtMs: number): number | null {
  const trimmed = buffer.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const whole = JSON.parse(trimmed) as Record<string, unknown>;
    if (whole.error) return null;
    if (typeof whole.output_text === 'string' && whole.output_text.trim()) {
      return Math.max(1, Date.now() - startedAtMs);
    }
    const choices = whole.choices as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(choices)) {
      const content = (choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined;
      if (content && typeof content.content === 'string' && content.content.trim()) {
        return Math.max(1, Date.now() - startedAtMs);
      }
    }
    if (Array.isArray(whole.output) && whole.output.length > 0) {
      return Math.max(1, Date.now() - startedAtMs);
    }
    if (Array.isArray(whole.content) && whole.content.length > 0) {
      return Math.max(1, Date.now() - startedAtMs);
    }
  } catch {
    // 不完整 JSON 或非 JSON
  }
  return null;
}

/** 从 buffer 提取流内错误(SSE data 行的 error 对象,或整体 JSON 的 error)。 */
function extractSseOrJsonError(buffer: string): string | null {
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        if (obj.error) {
          const err = obj.error as Record<string, unknown> | string;
          return typeof err === 'string' ? err : String(err.message || JSON.stringify(err));
        }
      } catch {
        // 忽略
      }
    }
  }
  try {
    const whole = JSON.parse(buffer.trim()) as Record<string, unknown>;
    if (whole.error) {
      const err = whole.error as Record<string, unknown> | string;
      return typeof err === 'string' ? err : String(err.message || JSON.stringify(err));
    }
  } catch {
    // 非整体 JSON
  }
  return null;
}

const MAX_PROBE_RESPONSE_CHARS = 96 * 1024;
/** 单次 reader.read() 超时：防止上游 socket pending 导致循环卡死。 */
const PROBE_READ_TIMEOUT_MS = 30_000;
/** 后台 drain 最大收尾时间：首字成功后不无限等流结束。 */
const PROBE_DRAIN_TIMEOUT_MS = 15_000;

/** 带单次超时的 reader.read()，超时后取消 reader 并返回 done。 */
type TimedReadResult = {
  result: ReadableStreamReadResult<Uint8Array>;
  timedOut: boolean;
};

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<TimedReadResult> {
  if (timeoutMs <= 0) return { result: await reader.read(), timedOut: false };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<TimedReadResult>((resolve) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      resolve({ result: { done: true, value: undefined }, timedOut: true });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      reader.read().then((result) => ({ result, timedOut: false })),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 流式读取上游响应,直到:
 * - 首个携带内容的 data chunk 到达(判定成功,返回 ttftMs)
 * - 检测到错误(返回 error)
 * - 流读完或超时(返回 done/text 由调用方走旧逻辑)
 * content-encoding 非空或无可读流时退避完整读取(readRuntimeResponseText 处理解压)。
 */
async function probeStreamFirstChunk(
  response: RuntimeResponse,
  timeoutMs: number,
): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  text: string;
  ttftMs: number | null;
  done: boolean;
  error: string | null;
}> {
  const encoding = typeof response.headers?.get === 'function'
    ? response.headers.get('content-encoding')
    : null;
  if (encoding) {
    const full = await readRuntimeResponseText(response as unknown as RuntimeResponse).catch(() => '');
    return { reader: null, text: full, ttftMs: null, done: true, error: null };
  }
  const reader = response.body?.getReader?.() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (!reader) {
    const full = await readRuntimeResponseText(response as unknown as RuntimeResponse).catch(() => '');
    return { reader: null, text: full, ttftMs: null, done: true, error: null };
  }

  const decoder = new TextDecoder('utf-8');
  let text = '';
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + Math.max(1, timeoutMs);
  while (Date.now() < deadlineMs) {
    const remaining = deadlineMs - Date.now();
    const { result: chunkResult, timedOut } = await readChunkWithTimeout(reader, Math.min(PROBE_READ_TIMEOUT_MS, remaining));
    const { value, done } = chunkResult;
    if (done && timedOut) {
      return { reader: null, text, ttftMs: null, done: false, error: 'probe stream read timeout' };
    }
    if (done) {
      if (!text) {
        // 流未提供数据(测试 mock/异常响应):回退 text() 完整读取
        const full = await readRuntimeResponseText(response).catch(() => '');
        const jsonTtft = firstJsonContentLatencyMs(full, startedAtMs);
        if (jsonTtft != null) {
          return { reader: null, text: full, ttftMs: jsonTtft, done: true, error: null };
        }
        return {
          reader: null,
          text: full,
          ttftMs: null,
          done: true,
          error: timedOut ? 'probe stream read timeout' : extractSseOrJsonError(full),
        };
      }
      // 流读完:整体 JSON 内容判定(非 SSE 响应)
      const jsonTtft = firstJsonContentLatencyMs(text, startedAtMs);
      if (jsonTtft != null) {
        return { reader, text, ttftMs: jsonTtft, done: true, error: null };
      }
      return {
        reader,
        text,
        ttftMs: null,
        done: true,
        error: timedOut ? 'probe stream read timeout' : extractSseOrJsonError(text),
      };
    }
    if (!value) continue;
    const chunk = decoder.decode(value, { stream: true });
    text += chunk;
    if (text.length > MAX_PROBE_RESPONSE_CHARS) break;
    const ttftMs = firstContentDeltaLatencyMs(text, startedAtMs)
      ?? firstJsonContentLatencyMs(text, startedAtMs);
    if (ttftMs != null) {
      return { reader, text, ttftMs, done: false, error: null };
    }
    const error = extractSseOrJsonError(text);
    if (error) {
      return { reader, text, ttftMs: null, done: false, error };
    }
  }
  return { reader, text, ttftMs: null, done: false, error: extractSseOrJsonError(text) };
}

/** 后台继续读完整流(用于写测活日志,不阻塞接口返回)。带最大收尾时间。 */
async function drainProbeStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: string,
): Promise<string> {
  const decoder = new TextDecoder('utf-8');
  let text = prefix;
  const deadlineMs = Date.now() + PROBE_DRAIN_TIMEOUT_MS;
  try {
    while (text.length < MAX_PROBE_RESPONSE_CHARS && Date.now() < deadlineMs) {
      const remaining = deadlineMs - Date.now();
      const { result: chunkResult } = await readChunkWithTimeout(reader, Math.min(PROBE_READ_TIMEOUT_MS, remaining));
      const { value, done } = chunkResult;
      if (done) break;
      if (!value) continue;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // 后台收尾失败不影响测活结果
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  return text;
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
  // 空凭据不拦截测活：公开站（/v1/chat/completions 无鉴权，如 free.empero.org）
  // 需要空 token 也能探测；需鉴权站返回 401 只记失败、无副作用。
  // 与模型发现的空凭据兜底（discoverModelsWithCredential allowEmpty）一致。

  const startedAt = Date.now();
  const deadlineAtMs = startedAt + Math.max(1, input.timeoutMs);
  try {
    // 与线上代理/模型发现一致：测活请求必须走站点配置的 API 入口（apiEndpoints），
    // 未配置入口时才回退 site.url。此前直接用 site.url 会让配置了 apiEndpoints 的
    // 站点把探测打到错误地址（例如官方站 404 页面），与真实路由不一致。
    const endpointBaseUrl = await withTimeout(
      () => requireSiteApiBaseUrl(input.site),
      resolveRemainingTimeoutMs(
        deadlineAtMs,
        'site api endpoint resolution timeout',
      ),
      'site api endpoint resolution timeout',
    );
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
    // 统一流式测活：所有平台 stream=true，首包即判定可用，且能拿到
    // 真实生成内容。Codex /responses 与 OpenAI 兼容 SSE 分别折叠。
    const probeStream = true;
    const { body: baseOpenaiBody, question: probeQuestion } = buildProbeBody(input.modelName);
    const openaiBody = { ...baseOpenaiBody, stream: probeStream };
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
        stream: probeStream,
        tokenValue,
        oauthProvider: oauth?.provider,
        oauthProjectId: oauth?.projectId,
        sitePlatform: input.site.platform,
        siteUrl: endpointBaseUrl,
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
        siteUrl: endpointBaseUrl,
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
        siteUrl: endpointBaseUrl,
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
      // 流式测活:首字(TTFT)即判定成功;HTTP 200 且流正常结束(无流内错误)
      // 也判定成功(空响应/测试环境),后台收流写日志,不等数据接收完
      const stream = await probeStreamFirstChunk(
        result.upstream,
        remainingExecutionTimeoutMs,
      );
      if (stream.ttftMs != null || (stream.done && !stream.error)) {
        const probeLatencyMs = stream.ttftMs ?? latencyMs;
        void (async () => {
          try {
            const fullText = stream.reader
              ? await drainProbeStream(stream.reader, stream.text)
              : stream.text;
            const folded = foldProbeResponseText(fullText, input.modelName);
            const tokensUsed = extractTokensFromResponse(folded);
            await db.insert(probeLogs).values({
              siteId: input.site.id,
              accountId: input.account.id,
              modelName: input.modelName,
              questionCategory: probeQuestion.category,
              questionText: probeQuestion.question,
              responseText: extractAssistantText(folded) || null,
              status: 'success',
              latencyMs: probeLatencyMs,
              tokensUsed,
            }).catch((err: unknown) => console.error('[probe-log] Failed to insert probe log:', err));
          } catch {
            // 后台日志失败不影响测活结果
          }
        })();
        return {
          status: 'supported',
          latencyMs: probeLatencyMs,
          reason: stream.ttftMs != null ? 'probe succeeded (first token)' : 'probe succeeded',
        };
      }

      // 首包阶段未成功:用已读文本走失败判定(HTTP 2xx 但流内错误/无内容)
      const streamError = stream.error || extractSseOrJsonError(stream.text);
      const rawErrorText = String(streamError || '').trim();
      const probeStatus = streamError ? 'unsupported' : 'inconclusive';
      await db.insert(probeLogs).values({
        siteId: input.site.id,
        accountId: input.account.id,
        modelName: input.modelName,
        questionCategory: probeQuestion.category,
        questionText: probeQuestion.question,
        responseText: null,
        status: 'failed',
        latencyMs,
        tokensUsed: null,
        errorMessage: classifyProbeFailureReason(0, rawErrorText),
      }).catch((err: unknown) => console.error('[probe-log] Failed to insert probe log:', err));

      return {
        status: probeStatus,
        latencyMs,
        reason: classifyProbeFailureReason(0, rawErrorText),
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
