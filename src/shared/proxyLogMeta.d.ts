export type ProxyLogUsageSource = 'upstream' | 'self-log' | 'unknown' | null;

export type ParsedProxyLogMetadata = {
  clientKind: string | null;
  sessionId: string | null;
  traceId: string | null;
  downstreamPath: string | null;
  upstreamPath: string | null;
  usageSource: ProxyLogUsageSource;
  errorCode: string | null;
  messageText: string;
};

export declare function parseProxyLogMetadata(rawMessage: string): ParsedProxyLogMetadata;
