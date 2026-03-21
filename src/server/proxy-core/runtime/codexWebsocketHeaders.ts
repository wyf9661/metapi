import { config } from '../../config.js';

function getHeaderValue(headers: Record<string, string>, key: string): string {
  const expected = key.trim().toLowerCase();
  for (const [candidateKey, candidateValue] of Object.entries(headers)) {
    if (candidateKey.trim().toLowerCase() !== expected) continue;
    return candidateValue;
  }
  return '';
}

export function buildCodexWebsocketHandshakeHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers };
  const websocketBeta = (config.codexResponsesWebsocketBeta || '').trim() || 'responses_websockets=2026-02-06';
  const openAiBeta = getHeaderValue(next, 'openai-beta').trim();
  if (!openAiBeta) {
    next['OpenAI-Beta'] = websocketBeta;
    return next;
  }
  if (!openAiBeta.includes('responses_websockets=')) {
    next['OpenAI-Beta'] = `${openAiBeta},${websocketBeta}`;
  }
  return next;
}

export function buildCodexWebsocketRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'response.create',
    ...body,
  };
}

export function toCodexWebsocketUrl(requestUrl: string): string {
  const parsed = new URL(requestUrl);
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  return parsed.toString();
}
