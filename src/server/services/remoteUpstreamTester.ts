import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fetch, type RequestInit as UndiciRequestInit } from 'undici';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';
import {
  normalizePlatformBaseUrl,
  resolveVersionedModelsUrl,
} from './platforms/standardApiProvider.js';

export type RemoteUpstreamProtocol = 'completion' | 'anthropic' | 'responses';

export type RemoteUpstreamListModelsInput = {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
};

export type RemoteUpstreamTestInput = {
  baseUrl: string;
  apiKey: string;
  protocol: RemoteUpstreamProtocol;
  model: string;
  prompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
};

export type RemoteUpstreamHttpResult = {
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  requestUrl: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  responseText: string;
  models?: string[];
  previewText?: string;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT = 'Reply with a single word: ok';
const DEFAULT_MAX_TOKENS = 16;
const MAX_MAX_TOKENS = 128;
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_RESPONSE_BYTES = 1_048_576; // 1 MB

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [0x0a000000, 0x0affffff],        // 10.0.0.0/8
  [0x7f000000, 0x7fffffff],        // 127.0.0.0/8 (loopback)
  [0xa9fe0000, 0xa9feffff],        // 169.254.0.0/16 (link-local)
  [0xac100000, 0xac1fffff],        // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff],        // 192.168.0.0/16
  [0x00000000, 0x00ffffff],        // 0.0.0.0/8
  [0xe0000000, 0xefffffff],        // 224.0.0.0/4 (multicast)
  [0xf0000000, 0xffffffff],        // 240.0.0.0/4 (reserved)
];

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const num = ipv4ToNumber(ip);
  if (num === null) return false;
  return PRIVATE_IPV4_RANGES.some(([start, end]) => num >= start && num <= end);
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  if (normalized === '::' || normalized === '::1') return true; // unspecified / loopback
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true; // fe80::/10
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7 ULA
  if (normalized.startsWith('ff')) return true; // multicast
  const mappedMatch = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedMatch) return isPrivateOrReservedIpv4(mappedMatch[1]);
  return false;
}

async function verifyHostAllowed(hostname: string): Promise<void> {
  let ips: string[];
  try {
    const result = await lookup(hostname, { all: true });
    ips = result.map((r: { address: string }) => r.address);
  } catch {
    throw new Error('DNS lookup failed');
  }
  for (const ip of ips) {
    if (isIP(ip) === 4) {
      if (isPrivateOrReservedIpv4(ip)) throw new Error(`Refused non-public IP ${ip}`);
    } else if (isIP(ip) === 6) {
      if (isPrivateOrReservedIpv6(ip)) throw new Error(`Refused non-public IP ${ip}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function normalizeRemoteBaseUrl(input: string): Promise<string> {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    throw new Error('baseUrl is required');
  }

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('baseUrl is not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('baseUrl must use http or https');
  }

  if (url.username || url.password) {
    throw new Error('baseUrl must not contain credentials');
  }

  await verifyHostAllowed(url.hostname);

  // If the user pasted a full endpoint (…/v1/models or …/chat/completions),
  // strip known leaf paths back to the API root used for joining.
  let pathname = url.pathname.replace(/\/+$/, '') || '';
  pathname = pathname
    .replace(/\/v1\/models$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/v1\/messages$/i, '')
    .replace(/\/messages$/i, '')
    .replace(/\/v1\/responses(?:\/compact)?$/i, '')
    .replace(/\/responses(?:\/compact)?$/i, '');

  url.pathname = pathname || '/';
  url.search = '';
  url.hash = '';

  return normalizePlatformBaseUrl(url.toString());
}

export async function resolveRemoteModelsUrl(baseUrl: string): Promise<string> {
  return resolveVersionedModelsUrl(await normalizeRemoteBaseUrl(baseUrl));
}

export async function resolveRemoteProtocolUrl(
  baseUrl: string,
  protocol: RemoteUpstreamProtocol,
): Promise<string> {
  const normalized = await normalizeRemoteBaseUrl(baseUrl);
  if (protocol === 'anthropic') {
    if (/\/v\d+(?:\.\d+)?(?:beta)?$/i.test(normalized)) {
      return `${normalized}/messages`;
    }
    return `${normalized}/v1/messages`;
  }
  if (protocol === 'responses') {
    if (/\/v\d+(?:\.\d+)?(?:beta)?$/i.test(normalized)) {
      return `${normalized}/responses`;
    }
    return `${normalized}/v1/responses`;
  }
  if (/\/v\d+(?:\.\d+)?(?:beta)?$/i.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

export function buildRemoteAuthHeaders(
  apiKey: string,
  protocol: RemoteUpstreamProtocol,
): Record<string, string> {
  const key = (apiKey || '').trim();
  if (!key) {
    throw new Error('apiKey is required');
  }

  if (protocol === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  return {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
  };
}

export function buildRemoteProtocolBody(
  protocol: RemoteUpstreamProtocol,
  model: string,
  prompt: string,
  maxTokens: number,
): Record<string, unknown> {
  const cleanedModel = model.trim();
  const cleanedPrompt = prompt.trim() || DEFAULT_PROMPT;
  const tokens = Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.floor(maxTokens)
    : DEFAULT_MAX_TOKENS;

  if (protocol === 'anthropic') {
    return {
      model: cleanedModel,
      max_tokens: tokens,
      messages: [{ role: 'user', content: cleanedPrompt }],
      stream: false,
    };
  }

  if (protocol === 'responses') {
    return {
      model: cleanedModel,
      input: cleanedPrompt,
      max_output_tokens: tokens,
      stream: false,
    };
  }

  return {
    model: cleanedModel,
    messages: [{ role: 'user', content: cleanedPrompt }],
    max_tokens: tokens,
    stream: false,
  };
}

export function extractRemoteModelNames(payload: unknown): string[] {
  const rows: unknown[] = (() => {
    if (Array.isArray(payload)) return payload;
    if (!isRecord(payload)) return [];
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.models)) return payload.models;
    if (Array.isArray(payload.result)) return payload.result;
    return [];
  })();

  const names = rows
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (!isRecord(item)) return '';
      if (typeof item.id === 'string') return item.id.trim();
      if (typeof item.model === 'string') return item.model.trim();
      if (typeof item.name === 'string') return item.name.trim();
      return '';
    })
    .filter((item) => item.length > 0);

  return Array.from(new Set(names));
}

function headersToRecord(headers: Headers | { forEach: (cb: (value: string, key: string) => void) => void }): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') {
      out[key] = '***';
      continue;
    }
    out[key] = value;
  }
  return out;
}

function parseResponseBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

function extractPreviewText(protocol: RemoteUpstreamProtocol, body: unknown): string {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 500);

  if (protocol === 'anthropic' && isRecord(body) && Array.isArray(body.content)) {
    return body.content
      .map((block) => {
        if (!isRecord(block)) return '';
        if (typeof block.text === 'string') return block.text;
        if (typeof block.thinking === 'string') return block.thinking;
        return '';
      })
      .filter(Boolean)
      .join('')
      .slice(0, 500);
  }

  if (protocol === 'responses' && isRecord(body)) {
    if (typeof body.output_text === 'string') return body.output_text.slice(0, 500);
    if (Array.isArray(body.output)) {
      const parts: string[] = [];
      for (const item of body.output) {
        if (!isRecord(item)) continue;
        if (typeof item.text === 'string') parts.push(item.text);
        if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
          }
        }
      }
      return parts.join('').slice(0, 500);
    }
  }

  if (isRecord(body) && Array.isArray(body.choices)) {
    const first = body.choices[0];
    if (isRecord(first)) {
      if (isRecord(first.message) && typeof first.message.content === 'string') {
        return first.message.content.slice(0, 500);
      }
      if (typeof first.text === 'string') return first.text.slice(0, 500);
    }
  }

  return '';
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
}

function clampMaxTokens(maxTokens: number | undefined): number {
  if (!maxTokens || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return DEFAULT_MAX_TOKENS;
  }
  return Math.min(Math.floor(maxTokens), MAX_MAX_TOKENS);
}

async function readBoundedResponseText(response: any): Promise<string> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    // No stream — fall back to full text but capped at MAX_RESPONSE_BYTES.
    const text = await readRuntimeResponseText(response);
    return text.length > MAX_RESPONSE_BYTES
      ? text.slice(0, MAX_RESPONSE_BYTES) + '\n[truncated]'
      : text;
  }

  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let output = '';
  let truncated = false;

  while (received < MAX_RESPONSE_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = decoder.decode(value, { stream: true });
    const remaining = MAX_RESPONSE_BYTES - received;
    if (chunk.length > remaining) {
      output += chunk.slice(0, remaining);
      received = MAX_RESPONSE_BYTES;
      truncated = true;
      break;
    }
    output += chunk;
    received += chunk.length;
  }

  if (truncated) output += '\n[truncated]';
  try { await reader.cancel(); } catch { /* ignore */ }
  return output;
}

async function requestRemote(options: {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}): Promise<{
  statusCode: number;
  latencyMs: number;
  responseHeaders: Record<string, string>;
  responseText: string;
  responseBody: unknown;
  ok: boolean;
  error?: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = Date.now();

  try {
    const requestInit: UndiciRequestInit = {
      method: options.method,
      headers: options.headers,
      body: options.body == null ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      redirect: 'manual',
    };
    const response = await fetch(options.url, requestInit);
    // Refuse redirects (manual redirect mode returns 3xx without following);
    // following them would risk leaking the auth header to attacker-controlled hosts.
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel?.(); } catch { /* ignore */ }
      return {
        statusCode: response.status,
        latencyMs: Date.now() - started,
        responseHeaders: headersToRecord(response.headers as any),
        responseText: '',
        responseBody: null,
        ok: false,
        error: `redirects are not allowed (HTTP ${response.status})`,
      };
    }
    const responseText = await readBoundedResponseText(response as any);
    const latencyMs = Date.now() - started;
    return {
      statusCode: response.status,
      latencyMs,
      responseHeaders: headersToRecord(response.headers as any),
      responseText,
      responseBody: parseResponseBody(responseText),
      ok: response.ok,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (error: any) {
    const latencyMs = Date.now() - started;
    const message = error?.name === 'AbortError'
      ? `request timeout after ${options.timeoutMs}ms`
      : (error?.message || String(error));
    return {
      statusCode: 0,
      latencyMs,
      responseHeaders: {},
      responseText: '',
      responseBody: null,
      ok: false,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function listRemoteUpstreamModels(
  input: RemoteUpstreamListModelsInput,
): Promise<RemoteUpstreamHttpResult> {
  const apiKey = (input.apiKey || '').trim();
  if (!apiKey) throw new Error('apiKey is required');

  const requestUrl = await resolveRemoteModelsUrl(input.baseUrl);
  const requestHeaders = buildRemoteAuthHeaders(apiKey, 'completion');
  const timeoutMs = clampTimeout(input.timeoutMs);

  const response = await requestRemote({
    url: requestUrl,
    method: 'GET',
    headers: requestHeaders,
    timeoutMs,
  });

  const models = response.ok ? extractRemoteModelNames(response.responseBody) : [];
  return {
    ok: response.ok && models.length > 0,
    statusCode: response.statusCode,
    latencyMs: response.latencyMs,
    requestUrl,
    requestHeaders: redactHeaders(requestHeaders),
    responseHeaders: response.responseHeaders,
    responseBody: response.responseBody,
    responseText: response.responseText,
    models,
    error: response.ok
      ? (models.length > 0 ? undefined : 'models payload did not contain any model ids')
      : response.error,
  };
}

export async function testRemoteUpstreamProtocol(
  input: RemoteUpstreamTestInput,
): Promise<RemoteUpstreamHttpResult> {
  const apiKey = (input.apiKey || '').trim();
  if (!apiKey) throw new Error('apiKey is required');
  const model = (input.model || '').trim();
  if (!model) throw new Error('model is required');

  const protocol = input.protocol;
  if (protocol !== 'completion' && protocol !== 'anthropic' && protocol !== 'responses') {
    throw new Error('protocol must be completion, anthropic, or responses');
  }

  const requestUrl = await resolveRemoteProtocolUrl(input.baseUrl, protocol);
  const requestHeaders = buildRemoteAuthHeaders(apiKey, protocol);
  const requestBody = buildRemoteProtocolBody(
    protocol,
    model,
    input.prompt || DEFAULT_PROMPT,
    clampMaxTokens(input.maxTokens),
  );
  const timeoutMs = clampTimeout(input.timeoutMs);

  const response = await requestRemote({
    url: requestUrl,
    method: 'POST',
    headers: requestHeaders,
    body: requestBody,
    timeoutMs,
  });

  return {
    ok: response.ok,
    statusCode: response.statusCode,
    latencyMs: response.latencyMs,
    requestUrl,
    requestHeaders: redactHeaders(requestHeaders),
    requestBody,
    responseHeaders: response.responseHeaders,
    responseBody: response.responseBody,
    responseText: response.responseText,
    previewText: extractPreviewText(protocol, response.responseBody),
    error: response.error,
  };
}
