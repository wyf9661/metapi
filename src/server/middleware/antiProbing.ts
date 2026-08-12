/**
 * Anti-probing middleware for downstream API keys.
 *
 * Detects requests that look like someone is testing whether a key is alive
 * (short messages, common probe patterns) and returns 400 with a misleading
 * "sensitive words detected" error — making the prober believe the upstream
 * has content moderation, not that this is a relay.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';

import { getProxyAuthContext } from './auth.js';

// ── Probe patterns ──────────────────────────────────────────────────────────
// Messages matching any of these (case-insensitive, trimmed) are blocked.
// `write` / `output` prefixes are intentionally NOT here: they are high-frequency
// in real coding/agent traffic ("write a test", "write a function") and were
// killing legitimate requests. `can you`-style capability prefixes are handled
// separately with a length bound so real questions are not blocked.
const PROBE_PATTERNS: RegExp[] = [
  // Minimal greetings / pings
  /^(hi|hello|hey|yo|ping|test|testing|123|1\+1|2\+2|ok|ok\.|hey)\s*$/i,
  // Short numeric sequences (111, 222, 333, etc.)
  /^(\d)\1{1,}\s*$/i,
  // Repeated single chars ("在吗在吗", "哈哈", "嘿嘿")
  /^(.)\1{1,}\s*$/,
  // Single Chinese char + punctuation ("在吗？", "在吗?", "在。")
  /^[\u4e00-\u9fff]{1,3}[?？!！。，、]*\s*$/,
  // Very short mixed text (< 5 chars, no spaces)
  /^[\w\u4e00-\u9fff]{1,4}$/,
  // "say X" / "repeat X" / "echo X" — classic probe
  /^(say|repeat|echo|print)\s+.{1,15}\s*$/i,
  // "what model" / "what are you" / "who are you"
  /^(what|who)\s+(model|are you|is your|version)/i,
  // API key / system prompt probing
  /(api[_\s-]?key|system[_\s-]?prompt|ignore\s+(previous|above|all)\s+instructions)/i,
  // "translate to English" — common minimal probe
  /^translate\s+.{1,30}\s*$/i,
];

// Capability-probing prefixes ("can you X"). Only treated as a probe when the
// whole message is short — a real question ("can you explain how X works in
// detail...") is longer than this and must pass through.
const CAPABILITY_PROBE_PATTERN = /^(can you|are you|do you|will you|shall you)\s+/i;
const CAPABILITY_PROBE_MAX_CHARS = 40;
// Messages at or above this length are never treated as probes.
const LONG_MESSAGE_ALLOW_CHARS = 60;

// ── Sensitive keyword list ──────────────────────────────────────────────────
// Requests whose last user message contains any of these (case-insensitive)
// are blocked.  These are common probe words that look like "content moderation"
// to the prober, not relay detection.
const SENSITIVE_KEYWORDS: string[] = [
  // ── 常见问候 / 探活词 ──
  '你好', '您好', '在吗', '在不在', '有人吗', '在么', '在不',
  'hello', 'hi', 'hey', 'yo', 'hola', 'bonjour', 'hallo', 'ciao',
  'test', 'testing', 'ping', 'pong', 'probe', 'check', 'alive',
  'ok', 'okay', '123', '1+1', '2+2', '111', '222', '333',
  '收到请回复', '看到请回复', '能听到吗', '听得见吗', '看得到吗',
  '喂', '哈喽', '嗨', '嘿', '在吗在吗', '在吗？', '在吗?', '在吗？',
  '有人么', '有没有人', '有人在线吗', '在线吗', '忙吗', '有空吗',
  '可以说话吗', '能说话吗', '会中文吗', '说中文', '讲中文',
  'who is there', 'anybody there', 'anyone there', 'are you there',
  'can you hear me', 'can you see me', 'do you read me',
  'are you online', 'are you available', 'are you busy',
  'good morning', 'good afternoon', 'good evening', 'good night',
  '早上好', '下午好', '晚上好', '晚安', '早安', '午安',

  // ── 常见探活指令 ──
  'say hello', 'say hi', 'say ok', 'say test',
  'repeat this', 'echo this', 'print this',
  'respond with', 'reply with',

  // ── 模型 / 系统探测 ──
  'what model', 'which model', 'model name', 'model version',
  'what are you', 'who are you', '你是谁', '你是什么',
  'system prompt', '系统提示', '初始指令',
  'ignore previous', 'ignore above', '忽略之前', '忽略上面',

  // ── 常见脏话 / 违规词（伪装成内容审核） ──
  'fuck', 'shit', 'damn', 'bitch', 'ass', 'hell',
  '操', '草', '妈的', '傻逼', '狗日', '王八蛋', '混蛋',
  '色情', '裸体', '暴力', '赌博', '毒品',

  // ── 政治敏感词（伪装成内容审核） ──
  '六四', '天安门', '法轮功', '台独', '藏独', '疆独',
  '习近平', '毛泽东', '共产党', '国民党',
  'tiananmen', 'falun gong', 'tibet independence',

  // ── 攻击性探测词 ──
  'hack', 'exploit', 'vulnerability', 'bypass',
  'jailbreak', 'prompt injection', 'prompt injection',
  'ignore all', 'ignore everything', 'disregard',
];

// Messages shorter than this (after trimming) are considered probes
// unless they contain structured content (tool calls, images, etc.).
const MIN_TEXT_LENGTH = 8;

// ── Text extraction ─────────────────────────────────────────────────────────

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          // OpenAI content parts
          if (typeof (part as Record<string, unknown>).text === 'string') {
            return (part as Record<string, unknown>).text as string;
          }
          // Claude content blocks
          if (
            (part as Record<string, unknown>).type === 'text'
            && typeof (part as Record<string, unknown>).text === 'string'
          ) {
            return (part as Record<string, unknown>).text as string;
          }
        }
        return '';
      })
      .join(' ');
  }
  return '';
}

function extractLastUserMessageText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;

  // OpenAI / Claude format: body.messages[]
  if (Array.isArray(record.messages)) {
    // Find the last user message
    for (let i = record.messages.length - 1; i >= 0; i--) {
      const msg = record.messages[i];
      if (msg && typeof msg === 'object' && (msg as Record<string, unknown>).role === 'user') {
        return extractTextFromContent((msg as Record<string, unknown>).content);
      }
    }
    return '';
  }

  // Gemini format: body.contents[]
  if (Array.isArray(record.contents)) {
    for (let i = record.contents.length - 1; i >= 0; i--) {
      const content = record.contents[i];
      if (content && typeof content === 'object') {
        const role = (content as Record<string, unknown>).role;
        if (role === 'user') {
          const parts = (content as Record<string, unknown>).parts;
          if (Array.isArray(parts)) {
            return parts
              .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
              .map((p) => (typeof p.text === 'string' ? p.text : ''))
              .join(' ');
          }
        }
      }
    }
    return '';
  }

  // Completions format: body.prompt (string or string[])
  if (typeof record.prompt === 'string') return record.prompt;
  if (Array.isArray(record.prompt)) return record.prompt.filter((p) => typeof p === 'string').join(' ');

  // Responses format: body.input (string or array)
  if (typeof record.input === 'string') return record.input;
  if (Array.isArray(record.input)) {
    return record.input
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') {
          return (item as Record<string, unknown>).text as string;
        }
        return '';
      })
      .join(' ');
  }

  return '';
}

function hasStructuredContent(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.messages)) return false;
  // Check if any message has tool_calls, images, or audio
  return record.messages.some((msg: unknown) => {
    if (!msg || typeof msg !== 'object') return false;
    const m = msg as Record<string, unknown>;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
    if (Array.isArray(m.content)) {
      return m.content.some((part: unknown) => {
        if (!part || typeof part !== 'object') return false;
        const p = part as Record<string, unknown>;
        return p.type === 'image_url' || p.type === 'image' || p.type === 'audio' || p.type === 'input_audio';
      });
    }
    return false;
  });
}

function hasSubstantivePriorUserContext(body: unknown, minTextLength: number): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;

  // OpenAI / Claude format: earlier user messages with real content mean this
  // is a continuing conversation, so a short latest message is a legitimate
  // follow-up ("谢谢", "继续", "再来一个") rather than a probe.
  if (Array.isArray(record.messages)) {
    for (let i = record.messages.length - 2; i >= 0; i--) {
      const msg = record.messages[i];
      if (msg && typeof msg === 'object' && (msg as Record<string, unknown>).role === 'user') {
        const text = extractTextFromContent((msg as Record<string, unknown>).content).trim();
        if (text.length >= minTextLength) return true;
      }
    }
    return false;
  }

  // Gemini format: body.contents[] — same multi-turn heuristic.
  if (Array.isArray(record.contents)) {
    for (let i = record.contents.length - 2; i >= 0; i--) {
      const content = record.contents[i];
      if (!content || typeof content !== 'object') continue;
      if ((content as Record<string, unknown>).role !== 'user') continue;
      const parts = (content as Record<string, unknown>).parts;
      if (!Array.isArray(parts)) continue;
      const text = parts
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join(' ')
        .trim();
      if (text.length >= minTextLength) return true;
    }
    return false;
  }

  return false;
}

// ── Detection ───────────────────────────────────────────────────────────────

export function isProbeRequest(body: unknown, minTextLength = MIN_TEXT_LENGTH): boolean {
  // Structured content (tool calls, images) = legitimate use
  if (hasStructuredContent(body)) return false;

  const text = extractLastUserMessageText(body).trim();
  if (!text) return false;

  // Long messages are never probes — real questions, code, and explanations
  // are longer than any probe payload.
  if (text.length >= LONG_MESSAGE_ALLOW_CHARS) return false;

  // Short text = likely probe... unless it's a follow-up in an ongoing
  // conversation, which is normal usage ("谢谢", "继续", "next").
  if (text.length < minTextLength) {
    if (hasSubstantivePriorUserContext(body, minTextLength)) return false;
    return true;
  }

  // Pattern match
  if (PROBE_PATTERNS.some((pattern) => pattern.test(text))) return true;

  // Capability prefix ("can you ...") only when the message is short.
  if (
    text.length <= CAPABILITY_PROBE_MAX_CHARS
    && CAPABILITY_PROBE_PATTERN.test(text)
  ) return true;

  // Sensitive keyword match (whole-word boundary for Latin keywords so
  // "this" is not flagged by "hi", "book" not flagged by "ok").
  if (SENSITIVE_KEYWORDS.length > 0) {
    const lower = text.toLowerCase();
    if (SENSITIVE_KEYWORDS.some((kw) => matchesSensitiveKeyword(lower, kw))) return true;
  }

  return false;
}

function matchesSensitiveKeyword(lowerText: string, keyword: string): boolean {
  const kw = keyword.toLowerCase();
  // Latin keywords: whole-word boundary match.
  if (/^[\x00-\x7F]+$/.test(kw)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(kw)}([^a-z0-9]|$)`).test(lowerText);
  }
  // CJK / mixed keywords have no word boundaries — substring match.
  return lowerText.includes(kw);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Paths that carry request bodies to check.
const BODY_CARRYING_PATHS = [
  '/v1/chat/completions',
  '/chat/completions',
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/responses',
  '/v1/images/generations',
  '/v1/audio/transcriptions',
  '/v1/audio/translations',
  '/v1/audio/speech',
  '/v1/videos/generations',
];

function shouldCheckPath(path: string): boolean {
  return BODY_CARRYING_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

// ── Middleware ───────────────────────────────────────────────────────────────

export async function antiProbingMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!shouldCheckPath(request.url)) return;
  if (request.method !== 'POST') return;

  const auth = getProxyAuthContext(request);
  if (!auth) return;

  // Per-key override: true = force on, false = force off, null = follow global
  let shouldEnforce: boolean;
  if (auth.sensitiveWordDetection === true) {
    shouldEnforce = true;
  } else if (auth.sensitiveWordDetection === false) {
    shouldEnforce = false;
  } else {
    // null → consult global settings (anti-probing defaults ON)
    const { resolveGlobalSensitiveWordDetection } = await import('../services/sensitiveWordDetectionService.js');
    shouldEnforce = await resolveGlobalSensitiveWordDetection();
  }
  if (!shouldEnforce) return;

  // Resolve the configurable short-text threshold from global settings.
  const { resolveAntiProbeMinTextLength } = await import('../services/sensitiveWordDetectionService.js');
  const minTextLength = await resolveAntiProbeMinTextLength();
  if (isProbeRequest(request.body, minTextLength)) {
    reply.code(400).send({
      error: {
        message: '敏感词检测：请求内容包含被限制的关键词，请修改后重试。',
        type: 'content_policy_violation',
        code: 'content_policy_violation',
      },
    });
    return;
  }
}
