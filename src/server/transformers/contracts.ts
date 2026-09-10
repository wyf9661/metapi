import type {
  CanonicalCliProfile,
  CanonicalContinuation,
  CanonicalOperation,
} from './canonical/types.js';
import type {
  ClaudeDownstreamContext,
  StreamTransformContext,
} from './shared/normalized.js';

export type ProtocolParseContext = {
  cliProfile?: CanonicalCliProfile;
  operation?: CanonicalOperation;
  continuation?: CanonicalContinuation;
  metadata?: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
  defaultEncryptedReasoningInclude?: boolean;
};

export type ProtocolBuildContext = {
  cliProfile?: CanonicalCliProfile;
};

export type ProtocolResponseContext = {
  modelName: string;
  fallbackText?: string;
};

export type ProtocolStreamContext = {
  modelName: string;
  streamContext?: StreamTransformContext;
};

export type ProtocolSerializeContext = {
  modelName: string;
  usage?: {
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
  };
  streamContext?: StreamTransformContext;
  claudeContext?: ClaudeDownstreamContext;
};

