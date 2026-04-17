import type { CanonicalTool, CanonicalToolChoice } from './tools.js';
import type { CanonicalAttachment } from './attachments.js';
import type {
  CanonicalCliProfile,
  CanonicalContinuation,
  CanonicalMessage,
  CanonicalOperation,
  CanonicalReasoningRequest,
  CanonicalRequestEnvelope,
  CanonicalSurface,
} from './types.js';
import { normalizeCanonicalContinuation } from './continuationBridge.js';

export type CreateCanonicalRequestEnvelopeInput = {
  operation?: CanonicalOperation;
  surface: CanonicalSurface;
  cliProfile?: CanonicalCliProfile;
  requestedModel: string;
  stream?: boolean;
  messages?: CanonicalMessage[];
  reasoning?: CanonicalReasoningRequest;
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  continuation?: CanonicalContinuation;
  metadata?: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
  attachments?: CanonicalAttachment[];
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    ) as T;
  }
  return value;
}

export function createCanonicalRequestEnvelope(
  input: CreateCanonicalRequestEnvelopeInput,
): CanonicalRequestEnvelope {
  const requestedModel = asTrimmedString(input.requestedModel);
  if (!requestedModel) {
    throw new Error('canonical request requires requestedModel');
  }

  return {
    operation: input.operation ?? 'generate',
    surface: input.surface,
    cliProfile: input.cliProfile ?? 'generic',
    requestedModel,
    stream: input.stream === true,
    messages: Array.isArray(input.messages) ? input.messages : [],
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(Array.isArray(input.tools) && input.tools.length > 0 ? { tools: input.tools } : {}),
    ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
    ...(normalizeCanonicalContinuation(input.continuation)
      ? { continuation: normalizeCanonicalContinuation(input.continuation) }
      : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.passthrough ? { passthrough: input.passthrough } : {}),
    ...(Array.isArray(input.attachments) && input.attachments.length > 0
      ? { attachments: cloneJsonValue(input.attachments) as CanonicalAttachment[] }
      : {}),
  };
}
