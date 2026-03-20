type ComposeProxyLogMessageArgs = {
  clientKind?: string | null;
  sessionId?: string | null;
  traceHint?: string | null;
  downstreamPath?: string | null;
  upstreamPath?: string | null;
  errorMessage?: string | null;
};

export type ParsedProxyLogMessageMeta = {
  clientKind: string | null;
  sessionId: string | null;
  downstreamPath: string | null;
  upstreamPath: string | null;
  messageText: string;
};

export function parseProxyLogMessageMeta(rawMessage: string): ParsedProxyLogMessageMeta {
  const clientMatch = rawMessage.match(/\[client:([^\]]+)\]/i);
  const sessionMatch = rawMessage.match(/\[session:([^\]]+)\]/i);
  const downstreamMatch = rawMessage.match(/\[downstream:([^\]]+)\]/i);
  const upstreamMatch = rawMessage.match(/\[upstream:([^\]]+)\]/i);
  const messageText = rawMessage.replace(
    /^\s*(?:\[(?:client|session|downstream|upstream):[^\]]+\]\s*)+/i,
    '',
  ).trim();
  return {
    clientKind: clientMatch?.[1]?.trim() || null,
    sessionId: sessionMatch?.[1]?.trim() || null,
    downstreamPath: downstreamMatch?.[1]?.trim() || null,
    upstreamPath: upstreamMatch?.[1]?.trim() || null,
    messageText,
  };
}

export function composeProxyLogMessage({
  clientKind,
  sessionId,
  traceHint,
  downstreamPath,
  upstreamPath,
  errorMessage,
}: ComposeProxyLogMessageArgs): string | null {
  const rawMessage = typeof errorMessage === 'string' ? errorMessage.trim() : '';
  const parsed = parseProxyLogMessageMeta(rawMessage);
  const finalClientKind = (clientKind || parsed.clientKind || '').trim();
  const finalSessionId = (sessionId || traceHint || parsed.sessionId || '').trim();
  const finalDownstreamPath = (downstreamPath || parsed.downstreamPath || '').trim();
  const finalUpstreamPath = (upstreamPath || parsed.upstreamPath || '').trim();
  const finalMessageText = parsed.messageText.trim();

  const prefixParts: string[] = [];
  if (finalClientKind) prefixParts.push(`[client:${finalClientKind}]`);
  if (finalSessionId) prefixParts.push(`[session:${finalSessionId}]`);
  if (finalDownstreamPath) prefixParts.push(`[downstream:${finalDownstreamPath}]`);
  if (finalUpstreamPath) prefixParts.push(`[upstream:${finalUpstreamPath}]`);

  if (prefixParts.length === 0 && !finalMessageText) return null;
  if (finalMessageText) return `${prefixParts.join(' ')} ${finalMessageText}`.trim();
  return prefixParts.join(' ');
}
