import { inferInputFileMimeType, normalizeInputFileBlock } from '../../transformers/shared/inputFile.js';

export type ConversationFileTransport = 'unsupported' | 'inline_only' | 'native';
export type ConversationFileEndpoint = 'chat' | 'messages' | 'responses';

export type ConversationFileInputSummary = {
  hasImage: boolean;
  hasAudio: boolean;
  hasDocument: boolean;
  hasRemoteDocumentUrl: boolean;
};

export type ConversationFileEndpointCapability = {
  image: ConversationFileTransport;
  audio: ConversationFileTransport;
  document: ConversationFileTransport;
  preservesRemoteDocumentUrl: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function classifyMimeFamily(mimeType: string | null): 'image' | 'audio' | 'document' {
  const normalized = asTrimmedString(mimeType).toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  return 'document';
}

function appendConversationFileSummary(
  summary: ConversationFileInputSummary,
  item: Record<string, unknown>,
): void {
  const normalizedFile = normalizeInputFileBlock(item);
  if (normalizedFile) {
    const mimeType = inferInputFileMimeType(normalizedFile);
    const family = classifyMimeFamily(mimeType);
    if (family === 'image') {
      summary.hasImage = true;
      return;
    }
    if (family === 'audio') {
      summary.hasAudio = true;
      return;
    }
    summary.hasDocument = true;
    if (normalizedFile.fileUrl) {
      summary.hasRemoteDocumentUrl = true;
    }
    return;
  }

  const type = asTrimmedString(item.type).toLowerCase();
  if (type === 'image_url' || type === 'input_image') {
    summary.hasImage = true;
    return;
  }

  if (type === 'input_audio') {
    summary.hasAudio = true;
    return;
  }

  if (Array.isArray(item.content)) {
    for (const nested of item.content) {
      if (isRecord(nested)) {
        appendConversationFileSummary(summary, nested);
      }
    }
  }
}

function createEmptySummary(): ConversationFileInputSummary {
  return {
    hasImage: false,
    hasAudio: false,
    hasDocument: false,
    hasRemoteDocumentUrl: false,
  };
}

export function summarizeConversationFileInputsInOpenAiBody(
  body: Record<string, unknown>,
): ConversationFileInputSummary {
  const summary = createEmptySummary();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (isRecord(item)) appendConversationFileSummary(summary, item);
      }
      continue;
    }
    if (isRecord(content)) {
      appendConversationFileSummary(summary, content);
    }
  }
  return summary;
}

export function summarizeConversationFileInputsInResponsesBody(
  body: Record<string, unknown>,
): ConversationFileInputSummary {
  const summary = createEmptySummary();
  const input = body.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (isRecord(item)) appendConversationFileSummary(summary, item);
    }
    return summary;
  }
  if (isRecord(input)) {
    appendConversationFileSummary(summary, input);
  }
  return summary;
}

export function resolveConversationFileEndpointCapability(input: {
  sitePlatform?: string;
  endpoint: ConversationFileEndpoint;
}): ConversationFileEndpointCapability {
  const platform = asTrimmedString(input.sitePlatform).toLowerCase();
  const endpoint = input.endpoint;

  if (platform === 'codex') {
    if (endpoint === 'responses') {
      return {
        image: 'native',
        audio: 'native',
        document: 'native',
        preservesRemoteDocumentUrl: true,
      };
    }
    return {
      image: 'unsupported',
      audio: 'unsupported',
      document: 'unsupported',
      preservesRemoteDocumentUrl: false,
    };
  }

  if (platform === 'claude') {
    if (endpoint === 'messages') {
      return {
        image: 'native',
        audio: 'unsupported',
        document: 'inline_only',
        preservesRemoteDocumentUrl: false,
      };
    }
    return {
      image: 'unsupported',
      audio: 'unsupported',
      document: 'unsupported',
      preservesRemoteDocumentUrl: false,
    };
  }

  if (platform === 'gemini-cli' || platform === 'antigravity') {
    if (endpoint === 'chat') {
      return {
        image: 'native',
        audio: 'native',
        document: 'inline_only',
        preservesRemoteDocumentUrl: false,
      };
    }
    return {
      image: 'unsupported',
      audio: 'unsupported',
      document: 'unsupported',
      preservesRemoteDocumentUrl: false,
    };
  }

  if (platform === 'gemini') {
    if (endpoint === 'responses') {
      return {
        image: 'native',
        audio: 'native',
        document: 'native',
        preservesRemoteDocumentUrl: true,
      };
    }
    if (endpoint === 'chat') {
      return {
        image: 'native',
        audio: 'native',
        document: 'inline_only',
        preservesRemoteDocumentUrl: false,
      };
    }
    return {
      image: 'unsupported',
      audio: 'unsupported',
      document: 'unsupported',
      preservesRemoteDocumentUrl: false,
    };
  }

  if (endpoint === 'responses') {
    return {
      image: 'native',
      audio: 'native',
      document: 'native',
      preservesRemoteDocumentUrl: true,
    };
  }

  if (endpoint === 'messages') {
    return {
      image: 'native',
      audio: 'unsupported',
      document: 'inline_only',
      preservesRemoteDocumentUrl: false,
    };
  }

  return {
    image: 'native',
    audio: 'native',
    document: 'inline_only',
    preservesRemoteDocumentUrl: false,
  };
}

export function rankConversationFileEndpoints(input: {
  sitePlatform?: string;
  requestedOrder: ConversationFileEndpoint[];
  summary: ConversationFileInputSummary;
  preferMessagesForClaudeModel?: boolean;
}): ConversationFileEndpoint[] {
  if (!input.summary.hasDocument) {
    return [...input.requestedOrder];
  }

  const preferredDocumentOrder = input.preferMessagesForClaudeModel === true
    ? ['messages', 'responses', 'chat']
    : ['responses', 'messages', 'chat'];

  const supportedDocumentEndpoints = preferredDocumentOrder.filter((endpoint) => {
    if (!input.requestedOrder.includes(endpoint as ConversationFileEndpoint)) return false;
    const capability = resolveConversationFileEndpointCapability({
      sitePlatform: input.sitePlatform,
      endpoint: endpoint as ConversationFileEndpoint,
    });
    if (capability.document === 'unsupported') return false;
    if (input.summary.hasRemoteDocumentUrl && !capability.preservesRemoteDocumentUrl) return false;
    return true;
  }) as ConversationFileEndpoint[];

  if (supportedDocumentEndpoints.length <= 0) {
    return [...input.requestedOrder];
  }

  return [
    ...supportedDocumentEndpoints,
    ...input.requestedOrder.filter((endpoint) => !supportedDocumentEndpoints.includes(endpoint)),
  ];
}
