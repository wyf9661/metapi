import { createHash } from 'node:crypto';

/**
 * Prefix-delta request bodies for cascaded metapi instances.
 *
 * A cascade hop re-uploads the whole prompt every turn. On agent traffic the
 * next turn is almost always the previous body plus an appended suffix — the
 * upstream prompt cache already proves it (98%+ read ratio) — so the repeated
 * prefix does not need to cross the tunnel again. The sending instance keeps
 * the last body it delivered per conversation, sends only the bytes after the
 * common prefix, and the receiving instance rebuilds the exact body from its
 * own copy before its parser runs.
 *
 * Negotiation mirrors requestBodyCompression: the receiver advertises
 * `x-metapi-body-delta: v1` on every response, the sender learns it per origin
 * and only deltas towards origins that asked for it. Any miss falls back to a
 * full body, so a peer that never advertised it keeps receiving one plain
 * request and the fast path can never break a hop.
 *
 * State is per hop, not per upstream: a provider-side `previous_response_id`
 * cannot be used here because the peer does not own that response state and
 * has to send the expanded body upstream anyway.
 */

export const REQUEST_BODY_DELTA_CAPABILITY_HEADER = 'x-metapi-body-delta';
export const REQUEST_BODY_DELTA_VERSION = 'v1';
export const REQUEST_BODY_DELTA_BASE_HEADER = 'x-metapi-body-delta-base';
export const REQUEST_BODY_DELTA_PREFIX_HEADER = 'x-metapi-body-delta-prefix';
export const REQUEST_BODY_DELTA_SHA256_HEADER = 'x-metapi-body-delta-sha256';

/**
 * The sender marks a full body with this header so the receiver keeps it for
 * the next turn. Without it the receiver would have to buffer and hash every
 * request body, including those from senders that never delta.
 */
export const REQUEST_BODY_STORE_HEADER = 'x-metapi-body-store';

export const REQUEST_BODY_DELTA_MIN_BYTES = 64 * 1024;
export const REQUEST_BODY_DELTA_MIN_PREFIX_BYTES = 32 * 1024;

/** Below this share of the body, the suffix is worth sending on its own. */
const REQUEST_BODY_DELTA_MAX_SUFFIX_RATIO = 0.5;

/** How much of the body identifies the conversation (model + system prompt). */
const CONVERSATION_KEY_BYTES = 2048;

const CACHE_TTL_MS = 10 * 60 * 1000;
const SENDER_CACHE_MAX_ENTRIES = 32;
const SENDER_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const RECEIVER_CACHE_MAX_ENTRIES = 64;
const RECEIVER_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** Bounded registry of origins that advertised support (LRU by recency). */
const CAPABILITY_CACHE_MAX_ENTRIES = 512;

type CachedBody = { hash: string; body: Buffer; at: number };

/**
 * Byte- and entry-bounded LRU. Bodies are up to a few MB each, so the entry
 * count alone is not a bound: a peer must not be able to grow this process.
 */
class BodyCache {
  private readonly entries = new Map<string, CachedBody>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  get(key: string, now = Date.now()): CachedBody | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (now - entry.at > CACHE_TTL_MS) {
      this.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: CachedBody): void {
    this.delete(key);
    this.entries.set(key, entry);
    this.bytes += entry.body.length;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes = Math.max(0, this.bytes - entry.body.length);
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}

const senderBodies = new BodyCache(SENDER_CACHE_MAX_ENTRIES, SENDER_CACHE_MAX_BYTES);
const receiverBodies = new BodyCache(RECEIVER_CACHE_MAX_ENTRIES, RECEIVER_CACHE_MAX_BYTES);
const deltaOrigins = new Set<string>();

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Cache scope: one downstream credential may not reference a body another one
 * stored. Without this, a caller could point at someone else's conversation,
 * append a short suffix, and have the model echo that conversation back.
 */
function tenantKey(authorization: string | null | undefined): string {
  return sha256(authorization || '').slice(0, 32);
}

export function learnUpstreamRequestBodyDeltaCapability(
  origin: string | null,
  response: { headers?: { get?: (name: string) => string | null } | null } | null | undefined,
): void {
  if (!origin) return;
  const raw = response?.headers?.get?.(REQUEST_BODY_DELTA_CAPABILITY_HEADER);
  if (typeof raw !== 'string' || raw.length === 0) return;
  const advertised = raw.split(',').map((value) => value.trim().toLowerCase());
  if (!advertised.includes(REQUEST_BODY_DELTA_VERSION)) return;

  if (deltaOrigins.has(origin)) deltaOrigins.delete(origin);
  deltaOrigins.add(origin);
  while (deltaOrigins.size > CAPABILITY_CACHE_MAX_ENTRIES) {
    const oldest = deltaOrigins.values().next();
    if (oldest.done) break;
    deltaOrigins.delete(oldest.value);
  }
}

/** Whether this origin advertised delta bodies (refreshes its recency). */
export function supportsRequestBodyDelta(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (!deltaOrigins.has(origin)) return false;
  deltaOrigins.delete(origin);
  deltaOrigins.add(origin);
  return true;
}

/**
 * A peer that answers a delta with a 400 and no capability header is not a
 * delta peer any more (rolled back or replaced). Stop trying until a response
 * advertises it again, otherwise every turn pays a rejected request first.
 */
export function forgetUpstreamRequestBodyDeltaCapability(origin: string | null): void {
  if (!origin) return;
  deltaOrigins.delete(origin);
}

function headerValue(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return String(headers[key]);
  }
  return '';
}

/** First byte where the two bodies differ, capped at the shorter one. */
export function commonPrefixLength(a: Buffer, b: Buffer): number {
  const max = Math.min(a.length, b.length);
  const CHUNK = 4096;
  let index = 0;
  while (index + CHUNK <= max) {
    if (!a.subarray(index, index + CHUNK).equals(b.subarray(index, index + CHUNK))) break;
    index += CHUNK;
  }
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function conversationCacheKey(origin: string, tenant: string, full: Buffer): string {
  return `${origin}|${tenant}|${sha256(full.subarray(0, CONVERSATION_KEY_BYTES))}`;
}

/**
 * Sender side: turn this body into a prefix delta against the last body sent
 * for the same conversation, or return null to send it whole.
 *
 * The key only finds a candidate; the prefix is measured against the actual
 * cached bytes, so a key collision (two conversations sharing a system prompt)
 * degrades to a short prefix and falls back to a full body rather than
 * producing a wrong one.
 */
export function buildDeltaRequestBody(input: {
  origin: string | null;
  headers: Record<string, string>;
  bodyText: string;
}): { bodyText: string; headers: Record<string, string> } | null {
  const { origin, headers, bodyText } = input;
  if (!origin || !supportsRequestBodyDelta(origin)) return null;

  const full = Buffer.from(bodyText);
  if (full.length < REQUEST_BODY_DELTA_MIN_BYTES) return null;

  const tenant = tenantKey(headerValue(headers, 'authorization'));
  const cached = senderBodies.get(conversationCacheKey(origin, tenant, full));
  if (!cached) return null;

  let prefixLength = commonPrefixLength(cached.body, full);
  // Never split a multi-byte character: the suffix is sent as a string.
  while (prefixLength > 0 && isUtf8Continuation(full[prefixLength])) prefixLength -= 1;
  if (prefixLength < REQUEST_BODY_DELTA_MIN_PREFIX_BYTES) return null;
  if (full.length - prefixLength > full.length * REQUEST_BODY_DELTA_MAX_SUFFIX_RATIO) return null;

  return {
    bodyText: full.subarray(prefixLength).toString('utf8'),
    headers: {
      [REQUEST_BODY_DELTA_BASE_HEADER]: cached.hash,
      [REQUEST_BODY_DELTA_PREFIX_HEADER]: String(prefixLength),
      [REQUEST_BODY_DELTA_SHA256_HEADER]: sha256(full),
    },
  };
}

/**
 * Sender side: remember a body the peer confirmed it received. Called after the
 * response, never before dispatch — a body still in flight must not become the
 * base of the next turn.
 */
export function rememberSentRequestBody(input: {
  origin: string | null;
  headers: Record<string, string>;
  bodyText: string | Buffer;
}): void {
  const { origin, headers, bodyText } = input;
  if (!origin || !supportsRequestBodyDelta(origin)) return;
  const full = Buffer.isBuffer(bodyText) ? bodyText : Buffer.from(bodyText);
  if (full.length < REQUEST_BODY_DELTA_MIN_BYTES) return;
  const tenant = tenantKey(headerValue(headers, 'authorization'));
  senderBodies.set(conversationCacheKey(origin, tenant, full), {
    hash: sha256(full),
    body: full,
    at: Date.now(),
  });
}

export type DeltaRequestHeaders = {
  baseHash: string;
  prefixLength: number;
  bodySha256: string;
};

/** Whether this request declares itself a delta (valid or not). */
export function hasDeltaRequestHeaders(headers: Record<string, unknown>): boolean {
  return headers[REQUEST_BODY_DELTA_BASE_HEADER] !== undefined;
}

/**
 * Parse the delta headers. Null means malformed: the caller must reject the
 * request rather than hand the suffix to the JSON parser, which would answer a
 * confusing 400 about the body instead of the header.
 */
export function parseDeltaRequestHeaders(
  headers: Record<string, unknown>,
): DeltaRequestHeaders | null {
  const first = (value: unknown): string | null => {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' ? raw : null;
  };
  const baseHash = first(headers[REQUEST_BODY_DELTA_BASE_HEADER]);
  const prefixRaw = first(headers[REQUEST_BODY_DELTA_PREFIX_HEADER]);
  const bodySha256 = first(headers[REQUEST_BODY_DELTA_SHA256_HEADER]);
  if (!baseHash || !/^[0-9a-f]{64}$/.test(baseHash)) return null;
  if (!bodySha256 || !/^[0-9a-f]{64}$/.test(bodySha256)) return null;
  if (!prefixRaw || !/^[0-9]+$/.test(prefixRaw)) return null;
  const prefixLength = Number(prefixRaw);
  if (!Number.isSafeInteger(prefixLength) || prefixLength <= 0) return null;
  return { baseHash, prefixLength, bodySha256 };
}

export type DeltaReconstructResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: 'miss' | 'invalid' };

/**
 * Receiver side: rebuild the full body from a cached base plus the suffix, or
 * report a miss so the sender resends it whole. The digest is over the
 * reconstructed bytes, so a stale/corrupt base can never be forwarded.
 */
export function reconstructDeltaBody(input: {
  authorization: string | null | undefined;
  delta: DeltaRequestHeaders;
  suffix: Buffer;
}): DeltaReconstructResult {
  const tenant = tenantKey(input.authorization);
  const cached = receiverBodies.get(`${tenant}|${input.delta.baseHash}`);
  if (!cached) return { ok: false, reason: 'miss' };
  if (input.delta.prefixLength > cached.body.length) return { ok: false, reason: 'invalid' };

  const body = Buffer.concat([
    cached.body.subarray(0, input.delta.prefixLength),
    input.suffix,
  ]);
  if (sha256(body) !== input.delta.bodySha256) return { ok: false, reason: 'invalid' };
  receiverBodies.set(`${tenant}|${input.delta.bodySha256}`, {
    hash: input.delta.bodySha256,
    body,
    at: Date.now(),
  });
  return { ok: true, body };
}

/** Receiver side: keep a full body the sender asked us to hold for next turn. */
export function rememberReceivedRequestBody(input: {
  authorization: string | null | undefined;
  body: Buffer;
}): void {
  if (input.body.length < REQUEST_BODY_DELTA_MIN_BYTES) return;
  const hash = sha256(input.body);
  receiverBodies.set(`${tenantKey(input.authorization)}|${hash}`, {
    hash,
    body: input.body,
    at: Date.now(),
  });
}

/** Test helpers. */
export function __resetRequestBodyDeltaForTests(): void {
  senderBodies.clear();
  receiverBodies.clear();
  deltaOrigins.clear();
}

export function __getRequestBodyDeltaStatsForTests(): {
  senderEntries: number;
  receiverEntries: number;
  trackedOrigins: number;
} {
  return {
    senderEntries: senderBodies.size,
    receiverEntries: receiverBodies.size,
    trackedOrigins: deltaOrigins.size,
  };
}


