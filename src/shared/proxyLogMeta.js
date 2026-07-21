export function parseProxyLogMetadata(rawMessage) {
  const text = typeof rawMessage === 'string' ? rawMessage : '';
  const clientMatch = text.match(/\[client:([^\]]+)\]/i);
  const sessionMatch = text.match(/\[session:([^\]]+)\]/i);
  const downstreamMatch = text.match(/\[downstream:([^\]]+)\]/i);
  const upstreamMatch = text.match(/\[upstream:([^\]]+)\]/i);
  const usageMatch = text.match(/\[usage:([^\]]+)\]/i);
  const codeMatch = text.match(/\[code:([^\]]+)\]/i);
  const messageText = text.replace(
    /^\s*(?:\[(?:client|session|downstream|upstream|usage|code):[^\]]+\]\s*)+/i,
    '',
  ).trim();

  return {
    clientKind: clientMatch?.[1]?.trim() || null,
    sessionId: sessionMatch?.[1]?.trim() || null,
    downstreamPath: downstreamMatch?.[1]?.trim() || null,
    upstreamPath: upstreamMatch?.[1]?.trim() || null,
    usageSource: usageMatch?.[1]?.trim() || null,
    errorCode: codeMatch?.[1]?.trim() || null,
    messageText,
  };
}
