type ProxyLogPathMeta = {
  clientFamily: string | null;
  sessionId: string | null;
  downstreamPath: string | null;
  upstreamPath: string | null;
  errorMessage: string;
};

export function parseProxyLogPathMeta(message?: string): ProxyLogPathMeta {
  const raw = typeof message === 'string' ? message.trim() : '';
  const clientMatch = raw.match(/\[client:([^\]]+)\]/i);
  const sessionMatch = raw.match(/\[session:([^\]]+)\]/i);
  const downstreamMatch = raw.match(/\[downstream:([^\]]+)\]/i);
  const upstreamMatch = raw.match(/\[upstream:([^\]]+)\]/i);
  const stripped = raw.replace(
    /^\s*(?:\[(?:client|session|downstream|upstream):[^\]]+\]\s*)+/i,
    '',
  ).trim();

  return {
    clientFamily: clientMatch?.[1]?.trim() || null,
    sessionId: sessionMatch?.[1]?.trim() || null,
    downstreamPath: downstreamMatch?.[1]?.trim() || null,
    upstreamPath: upstreamMatch?.[1]?.trim() || null,
    errorMessage: stripped,
  };
}
