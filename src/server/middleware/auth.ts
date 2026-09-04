import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { authorizeDownstreamToken, checkManagedKeyRpmLimit, consumeManagedKeyRequest, releaseManagedKeyInflight, tryAcquireManagedKeyInflight } from '../services/downstreamApiKeyService.js';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY, type DownstreamRoutingPolicy } from '../services/downstreamPolicyTypes.js';
import { getTrustedClientIp, isIpAllowed } from './clientIp.js';

export {
  extractClientIp,
  findInvalidIpAllowlistEntries,
  getTrustedClientIp,
  isIpAllowed,
} from './clientIp.js';

export interface ProxyAuthContext {
  token: string;
  source: 'managed' | 'playground';
  keyId: number | null;
  keyName: string;
  policy: DownstreamRoutingPolicy;
  sensitiveWordDetection: boolean | null;
}

export interface ProxyResourceOwner {
  ownerType: 'managed_key' | 'playground';
  ownerId: string;
}

const proxyAuthContextByRequest = new WeakMap<FastifyRequest, ProxyAuthContext>();

// NewAPI-style ephemeral playground tokens: issued in-memory for admin session
// tester requests. Not persisted, short-lived, and not a managed downstream key.
const PLAYGROUND_TOKEN_TTL_MS = 10 * 60 * 1000;
const playgroundTokens = new Map<string, { expiresAt: number; name: string }>();

function hashPlaygroundToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cleanupPlaygroundTokens(now = Date.now()) {
  for (const [hash, item] of playgroundTokens.entries()) {
    if (item.expiresAt <= now) playgroundTokens.delete(hash);
  }
}

export function issuePlaygroundProxyToken(name = 'playground'): string {
  cleanupPlaygroundTokens();
  const token = `sk-pg-${randomBytes(24).toString('hex')}`;
  playgroundTokens.set(hashPlaygroundToken(token), {
    expiresAt: Date.now() + PLAYGROUND_TOKEN_TTL_MS,
    name,
  });
  return token;
}

export function peekPlaygroundProxyToken(token: string): { name: string } | null {
  cleanupPlaygroundTokens();
  const item = playgroundTokens.get(hashPlaygroundToken(token));
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    playgroundTokens.delete(hashPlaygroundToken(token));
    return null;
  }
  return { name: item.name };
}

export function __resetPlaygroundProxyTokensForTests(): void {
  playgroundTokens.clear();
}

export function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) {
    // Compare against self to keep runtime roughly constant on length mismatch.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const clientIp = getTrustedClientIp(request);
  if (!isIpAllowed(clientIp, config.adminIpAllowlist)) {
    reply.code(403).send({ error: 'IP not allowed' });
    return;
  }

  const auth = request.headers.authorization;
  if (!auth) {
    reply.code(401).send({ error: 'Missing Authorization header' });
    return;
  }
  const token = auth.replace('Bearer ', '');
  if (!secretsEqual(token, config.authToken)) {
    reply.code(403).send({ error: 'Invalid token' });
    return;
  }
}

export async function proxyAuthMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const auth = typeof request.headers.authorization === 'string'
    ? request.headers.authorization
    : '';
  const apiKeyHeader = typeof request.headers['x-api-key'] === 'string'
    ? request.headers['x-api-key']
    : '';
  const googApiKeyHeader = typeof request.headers['x-goog-api-key'] === 'string'
    ? request.headers['x-goog-api-key']
    : '';
  const queryKey = (
    request.query
    && typeof request.query === 'object'
    && typeof (request.query as Record<string, unknown>).key === 'string'
  )
    ? String((request.query as Record<string, unknown>).key).trim()
    : '';
  const token = auth
    ? auth.replace(/^Bearer\s+/i, '').trim()
    : (apiKeyHeader.trim() || googApiKeyHeader.trim() || queryKey);

  if (!token) {
    reply.code(401).send({ error: 'Missing Authorization, x-api-key, x-goog-api-key, or key query parameter' });
    return;
  }

  const playground = peekPlaygroundProxyToken(token);
  if (playground) {
    proxyAuthContextByRequest.set(request, {
      token,
      source: 'playground',
      keyId: null,
      keyName: playground.name || 'playground',
      policy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      sensitiveWordDetection: null,
    });
    return;
  }

  const authResult = await authorizeDownstreamToken(token);
  if (!authResult.ok) {
    reply.code(authResult.statusCode).send({ error: authResult.error });
    return;
  }

  if (authResult.source === 'managed' && authResult.key) {
    const rpm = checkManagedKeyRpmLimit(authResult.key.id, authResult.key.maxRpm);
    if (!rpm.allowed) {
      reply
        .code(429)
        .header('retry-after', String(rpm.retryAfterSec))
        .send({ error: `API key RPM limit exceeded (${authResult.key.maxRpm}/min)` });
      return;
    }
    // Concurrent in-flight ceiling (max_inflight). Acquired here so every
    // /v1 proxy path (chat/responses/embeddings/etc.) is covered; released on
    // response finish/close regardless of how the request ends.
    const inflightAllowed = tryAcquireManagedKeyInflight(authResult.key.id, authResult.key.maxInflight);
    if (!inflightAllowed) {
      reply
        .code(429)
        .header('retry-after', '1')
        .send({ error: `API key concurrent request limit exceeded (${authResult.key.maxInflight})` });
      return;
    }
    let inflightReleased = false;
    const releaseInflightOnce = () => {
      if (inflightReleased) return;
      inflightReleased = true;
      releaseManagedKeyInflight(authResult.key!.id);
    };
    reply.raw.once('finish', releaseInflightOnce);
    reply.raw.once('close', releaseInflightOnce);
    const consumed = await consumeManagedKeyRequest(authResult.key.id);
    if (consumed === false) {
      reply.code(403).send({ error: 'API key has exceeded request quota (lifetime or daily)' });
      return;
    }
  }

  proxyAuthContextByRequest.set(request, {
    token: authResult.token,
    source: authResult.source,
    keyId: authResult.key?.id ?? null,
    keyName: authResult.key?.name || 'global',
    policy: authResult.policy || EMPTY_DOWNSTREAM_ROUTING_POLICY,
    sensitiveWordDetection: authResult.key?.sensitiveWordDetection ?? null,
  });
}

export function getProxyAuthContext(request: FastifyRequest): ProxyAuthContext | null {
  return proxyAuthContextByRequest.get(request) || null;
}

export function getProxyResourceOwner(request: FastifyRequest): ProxyResourceOwner | null {
  const auth = getProxyAuthContext(request);
  if (!auth) return null;

  if (auth.source === 'managed') {
    return {
      ownerType: 'managed_key',
      ownerId: auth.keyId === null ? auth.token : String(auth.keyId),
    };
  }

  if (auth.source === 'playground') {
    return {
      ownerType: 'playground',
      ownerId: auth.keyName || 'playground',
    };
  }

  return {
    ownerType: 'managed_key',
    ownerId: 'unknown',
  };
}
