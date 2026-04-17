import {
  canonicalAttachmentFromInputFileBlock,
  canonicalAttachmentToNormalizedInputFile,
  type CanonicalAttachment,
} from './attachments.js';
import { createCanonicalRequestEnvelope } from './envelope.js';
import {
  applyOpenAiCompatibleContinuation,
  readOpenAiCompatibleContinuation,
} from './continuationBridge.js';
import { normalizeCanonicalReasoningRequest } from './reasoning.js';
import type { CanonicalTool, CanonicalToolChoice } from './tools.js';
import type {
  CanonicalContentPart,
  CanonicalCliProfile,
  CanonicalContinuation,
  CanonicalMessage,
  CanonicalMessageRole,
  CanonicalOperation,
  CanonicalRequestEnvelope,
  CanonicalSurface,
} from './types.js';
import { toOpenAiChatFileBlock } from '../shared/inputFile.js';

type CanonicalRequestFromOpenAiBodyInput = {
  body: Record<string, unknown>;
  surface: CanonicalSurface;
  cliProfile?: CanonicalCliProfile;
  operation?: CanonicalOperation;
  metadata?: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
  continuation?: CanonicalContinuation;
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

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function joinNonEmpty(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function normalizeRole(value: unknown): CanonicalMessageRole {
  const role = asTrimmedString(value).toLowerCase();
  switch (role) {
    case 'system':
    case 'developer':
    case 'assistant':
    case 'tool':
      return role;
    default:
      return 'user';
  }
}

function openAiContentToCanonicalParts(content: unknown): CanonicalContentPart[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }

  if (!Array.isArray(content)) return [];

  const parts: CanonicalContentPart[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      if (item) parts.push({ type: 'text', text: item });
      continue;
    }
    if (!isRecord(item)) continue;

    const type = asTrimmedString(item.type).toLowerCase();
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = asTrimmedString(item.text);
      if (text) parts.push({ type: 'text', text });
      continue;
    }
    if (type === 'reasoning' || type === 'thinking' || type === 'redacted_reasoning') {
      const text = asTrimmedString(item.text ?? item.reasoning ?? item.thinking);
      if (text) parts.push({ type: 'text', text, thought: true });
      continue;
    }
    if (type === 'image_url' && isRecord(item.image_url)) {
      const url = asTrimmedString(item.image_url.url);
      if (url) parts.push({ type: 'image', url });
      continue;
    }
    if (type === 'input_image' && isRecord(item.image_url)) {
      const url = asTrimmedString(item.image_url.url);
      if (url) parts.push({ type: 'image', url });
      continue;
    }
    if (type === 'input_file' || type === 'file') {
      const attachment = canonicalAttachmentFromInputFileBlock(item);
      if (attachment) {
        parts.push({
          type: 'file',
          ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
          ...(attachment.fileUrl ? { fileUrl: attachment.fileUrl } : {}),
          ...(attachment.fileData ? { fileData: attachment.fileData } : {}),
          ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
          ...(attachment.filename ? { filename: attachment.filename } : {}),
        });
      }
      continue;
    }
  }

  return parts;
}

function appendAssistantReasoningPart(
  parts: CanonicalContentPart[],
  rawMessage: Record<string, unknown>,
): void {
  const directReasoning = joinNonEmpty([
    asTrimmedString(rawMessage.reasoning_content),
    asTrimmedString(rawMessage.reasoning),
  ]);
  if (!directReasoning) return;

  const alreadyPresent = parts.some((part) => (
    part.type === 'text'
    && part.thought === true
    && part.text === directReasoning
  ));
  if (alreadyPresent) return;

  parts.unshift({
    type: 'text',
    text: directReasoning,
    thought: true,
  });
}

function parseToolChoice(rawToolChoice: unknown): CanonicalToolChoice | undefined {
  if (typeof rawToolChoice === 'string') {
    const normalized = rawToolChoice.trim().toLowerCase();
    if (normalized === 'auto' || normalized === 'none' || normalized === 'required') return normalized;
    if (normalized === 'any') return 'required';
    return rawToolChoice.trim() ? { type: 'raw', value: rawToolChoice } : undefined;
  }

  if (!isRecord(rawToolChoice)) return undefined;
  const type = asTrimmedString(rawToolChoice.type).toLowerCase();
  if (type === 'auto' || type === 'none') return type;
  if (type === 'any' || type === 'required') return 'required';
  if (type === 'function') {
    const name = asTrimmedString(
      (isRecord(rawToolChoice.function) ? rawToolChoice.function.name : undefined)
      ?? rawToolChoice.name,
    );
    return name ? { type: 'tool', name } : undefined;
  }
  if (type && type !== 'tool') {
    return { type: 'raw', value: cloneJsonValue(rawToolChoice) as Record<string, unknown> };
  }

  const name = asTrimmedString(
    rawToolChoice.name
    ?? (isRecord(rawToolChoice.tool) ? rawToolChoice.tool.name : undefined),
  );
  const toolChoiceKeys = Object.keys(rawToolChoice);
  const hasExtraToolFields = toolChoiceKeys.some((key) => key !== 'type' && key !== 'name' && key !== 'tool');
  if (hasExtraToolFields) {
    return { type: 'raw', value: cloneJsonValue(rawToolChoice) as Record<string, unknown> };
  }
  if (name) return { type: 'tool', name };
  return { type: 'raw', value: cloneJsonValue(rawToolChoice) as Record<string, unknown> };
}

function parseTools(rawTools: unknown): CanonicalTool[] | undefined {
  if (!Array.isArray(rawTools)) return undefined;

  const tools: CanonicalTool[] = rawTools
    .flatMap((item): CanonicalTool[] => {
      if (!isRecord(item)) return [];
      const itemType = asTrimmedString(item.type).toLowerCase();

      if (itemType === 'function' && isRecord(item.function)) {
        const name = asTrimmedString(item.function.name);
        if (!name) return [];
        return [{
          name,
          ...(asTrimmedString(item.function.description)
            ? { description: asTrimmedString(item.function.description) }
            : {}),
          ...(typeof item.function.strict === 'boolean' ? { strict: item.function.strict } : {}),
          ...(isRecord(item.function.parameters) ? { inputSchema: cloneJsonValue(item.function.parameters) } : {}),
        }];
      }

      if ((itemType === '' || itemType === 'tool') && asTrimmedString(item.name)) {
        return [{
          name: asTrimmedString(item.name),
          ...(asTrimmedString(item.description)
            ? { description: asTrimmedString(item.description) }
            : {}),
          ...(typeof item.strict === 'boolean' ? { strict: item.strict } : {}),
          ...(isRecord(item.input_schema)
            ? { inputSchema: cloneJsonValue(item.input_schema) }
            : (isRecord(item.inputSchema) ? { inputSchema: cloneJsonValue(item.inputSchema) } : {})),
        }];
      }

      if (Array.isArray(item.functionDeclarations)) {
        return item.functionDeclarations.flatMap((declaration) => {
          if (!isRecord(declaration)) return [];
          const name = asTrimmedString(declaration.name);
          if (!name) return [];
          return [{
            name,
            ...(asTrimmedString(declaration.description)
              ? { description: asTrimmedString(declaration.description) }
              : {}),
            ...(isRecord(declaration.parametersJsonSchema)
              ? { inputSchema: cloneJsonValue(declaration.parametersJsonSchema) }
              : (isRecord(declaration.parameters) ? { inputSchema: cloneJsonValue(declaration.parameters) } : {})),
          }];
        });
      }

      if (itemType) {
        return [{
          type: itemType,
          raw: cloneJsonValue(item) as Record<string, unknown>,
        }];
      }

      return [];
    });

  return tools.length > 0 ? tools : undefined;
}

export function canonicalRequestFromOpenAiBody(
  input: CanonicalRequestFromOpenAiBodyInput,
): CanonicalRequestEnvelope {
  const body = input.body;
  const metadata = isRecord(input.metadata)
    ? input.metadata
    : (isRecord(body.metadata) ? cloneJsonValue(body.metadata) : undefined);
  const attachments = Array.isArray(body.attachments)
    ? cloneJsonValue(body.attachments) as CanonicalAttachment[]
    : undefined;
  const messages: CanonicalMessage[] = [];
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];

  for (const rawMessage of rawMessages) {
    if (!isRecord(rawMessage)) continue;
    const role = normalizeRole(rawMessage.role);

    if (role === 'tool') {
      const toolCallId = asTrimmedString(rawMessage.tool_call_id ?? rawMessage.id);
      const rawContent = rawMessage.content;
      const resultText = typeof rawContent === 'string'
        ? rawContent
        : (!Array.isArray(rawContent) && !isRecord(rawContent) ? safeJsonStringify(rawContent ?? '') : '');
      messages.push({
        role: 'tool',
        parts: [{
          type: 'tool_result',
          toolCallId: toolCallId || 'tool',
          ...(resultText ? { resultText } : {}),
          ...(Array.isArray(rawContent)
            ? { resultContent: cloneJsonValue(rawContent) as Array<string | Record<string, unknown>> }
            : (isRecord(rawContent)
                ? { resultContent: [cloneJsonValue(rawContent) as Record<string, unknown>] }
                : {})),
        }],
      });
      continue;
    }

    const parts = openAiContentToCanonicalParts(rawMessage.content);
    if (role === 'assistant') {
      appendAssistantReasoningPart(parts, rawMessage);
    }
    const toolCalls = Array.isArray(rawMessage.tool_calls) ? rawMessage.tool_calls : [];
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) continue;
      const fn = isRecord(toolCall.function) ? toolCall.function : {};
      const id = asTrimmedString(toolCall.id);
      const name = asTrimmedString(toolCall.name ?? fn.name);
      const argumentsJson = typeof fn.arguments === 'string'
        ? fn.arguments
        : safeJsonStringify(fn.arguments ?? toolCall.arguments ?? {});
      if (!name) continue;
      parts.push({
        type: 'tool_call',
        id: id || `tool_${parts.length}`,
        name,
        argumentsJson,
      });
    }

    messages.push({
      role,
      parts,
      ...(asTrimmedString(rawMessage.phase) ? { phase: asTrimmedString(rawMessage.phase) } : {}),
      ...(asTrimmedString(rawMessage.reasoning_signature)
        ? { reasoningSignature: asTrimmedString(rawMessage.reasoning_signature) }
        : {}),
    });
  }

  const reasoningResult = normalizeCanonicalReasoningRequest({
    include: body.include,
    reasoning: body.reasoning,
    reasoning_effort: body.reasoning_effort,
    reasoning_budget: body.reasoning_budget,
    reasoning_summary: body.reasoning_summary,
  });

  const continuation = readOpenAiCompatibleContinuation(body, input.continuation);

  const passthrough = {
    ...(input.passthrough ?? {}),
    ...(typeof body.parallel_tool_calls === 'boolean'
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
    ...(reasoningResult.metadata ? { transformerMetadata: reasoningResult.metadata } : {}),
  };

  return createCanonicalRequestEnvelope({
    operation: input.operation ?? 'generate',
    surface: input.surface,
    cliProfile: input.cliProfile ?? 'generic',
    requestedModel: asTrimmedString(body.model),
    stream: body.stream === true,
    messages,
    ...(reasoningResult.reasoning ? { reasoning: reasoningResult.reasoning } : {}),
    ...(parseTools(body.tools) ? { tools: parseTools(body.tools) } : {}),
    ...(parseToolChoice(body.tool_choice) !== undefined ? { toolChoice: parseToolChoice(body.tool_choice) } : {}),
    ...(continuation ? { continuation } : {}),
    ...(metadata ? { metadata } : {}),
    ...(attachments ? { attachments } : {}),
    ...(Object.keys(passthrough).length > 0 ? { passthrough } : {}),
  });
}

function canonicalPartsToOpenAiContent(
  role: CanonicalMessageRole,
  parts: CanonicalContentPart[],
): { content: string | Array<Record<string, unknown>>; reasoning?: string; toolCalls?: Array<Record<string, unknown>> } {
  const contentBlocks: Array<Record<string, unknown>> = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const visibleText: string[] = [];
  const reasoningText: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      if (part.thought === true) {
        reasoningText.push(part.text);
      } else {
        visibleText.push(part.text);
      }
      continue;
    }
    if (part.type === 'image') {
      const url = asTrimmedString(part.url ?? part.dataUrl);
      if (url) {
        contentBlocks.push({
          type: 'image_url',
          image_url: { url },
        });
      }
      continue;
    }
    if (part.type === 'file') {
      const normalizedFile = canonicalAttachmentToNormalizedInputFile({
        kind: 'file',
        ...(part.fileId ? { fileId: part.fileId } : {}),
        ...(part.fileUrl ? { fileUrl: part.fileUrl } : {}),
        ...(part.fileData ? { fileData: part.fileData } : {}),
        ...(part.filename ? { filename: part.filename } : {}),
        ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}),
      });
      contentBlocks.push(toOpenAiChatFileBlock(normalizedFile));
      continue;
    }
    if (part.type === 'tool_call') {
      toolCalls.push({
        id: part.id,
        type: 'function',
        function: {
          name: part.name,
          arguments: part.argumentsJson,
        },
      });
      continue;
    }
    if (part.type === 'tool_result' && role !== 'tool') {
      const text = part.resultText
        ?? (typeof part.resultContent === 'string'
          ? part.resultContent
          : safeJsonStringify(part.resultJson ?? part.resultContent ?? ''));
      if (text) {
        visibleText.push(text);
      }
    }
  }

  if (contentBlocks.length <= 0) {
    return {
      content: visibleText.join(''),
      ...(reasoningText.length > 0 ? { reasoning: reasoningText.join('') } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  if (visibleText.length > 0) {
    contentBlocks.unshift({
      type: 'text',
      text: visibleText.join(''),
    });
  }

  return {
    content: contentBlocks,
    ...(reasoningText.length > 0 ? { reasoning: reasoningText.join('') } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function canonicalToolChoiceToOpenAi(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto' || toolChoice === 'none') return toolChoice;
  if (toolChoice === 'required') return 'required';
  if (toolChoice.type === 'raw') return cloneJsonValue(toolChoice.value);
  return {
    type: 'function',
    function: {
      name: toolChoice.name,
    },
  };
}

export function canonicalRequestToOpenAiChatBody(
  request: CanonicalRequestEnvelope,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  for (const message of request.messages) {
    if (message.role === 'tool') {
      for (const part of message.parts) {
        if (part.type !== 'tool_result') continue;
        messages.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          content: part.resultContent
            ?? part.resultText
            ?? safeJsonStringify(part.resultJson ?? ''),
        });
      }
      continue;
    }

    const converted = canonicalPartsToOpenAiContent(message.role, message.parts);
    const nextMessage: Record<string, unknown> = {
      role: message.role,
      content: converted.content,
    };
    if (message.role === 'assistant' && converted.reasoning) {
      nextMessage.reasoning_content = converted.reasoning;
    }
    if (message.phase) nextMessage.phase = message.phase;
    if (message.reasoningSignature) nextMessage.reasoning_signature = message.reasoningSignature;
    if (message.role === 'assistant' && converted.toolCalls && converted.toolCalls.length > 0) {
      nextMessage.tool_calls = converted.toolCalls;
      if (typeof nextMessage.content !== 'string' && (nextMessage.content as Array<unknown>).length <= 0) {
        nextMessage.content = '';
      }
    }
    messages.push(nextMessage);
  }

  const body: Record<string, unknown> = {
    model: request.requestedModel,
    stream: request.stream,
    messages,
  };

  if (request.reasoning?.effort) body.reasoning_effort = request.reasoning.effort;
  if (request.reasoning?.budgetTokens !== undefined) body.reasoning_budget = request.reasoning.budgetTokens;
  if (request.reasoning?.summary) body.reasoning_summary = request.reasoning.summary;
  const transformerMetadata = isRecord(request.passthrough?.transformerMetadata)
    ? request.passthrough.transformerMetadata as Record<string, unknown>
    : null;
  const passthroughInclude = Array.isArray(transformerMetadata?.include)
    ? (transformerMetadata.include as unknown[])
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
  const mergedInclude = [
    ...(request.reasoning?.includeEncryptedContent ? ['reasoning.encrypted_content'] : []),
    ...passthroughInclude,
  ].filter((item, index, all) => all.indexOf(item) === index);
  if (mergedInclude.length > 0) body.include = mergedInclude;
  const metadata = isRecord(request.metadata)
    ? cloneJsonValue(request.metadata)
    : {};
  applyOpenAiCompatibleContinuation(body, request.continuation, metadata);
  if (Array.isArray(request.attachments) && request.attachments.length > 0) {
    body.attachments = cloneJsonValue(request.attachments);
  }
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => {
      if ('raw' in tool) {
        const raw = cloneJsonValue(tool.raw) as Record<string, unknown>;
        if (typeof raw.type !== 'string' || raw.type.trim().length === 0) {
          raw.type = tool.type;
        }
        return raw;
      }
      return {
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
          parameters: cloneJsonValue(tool.inputSchema ?? { type: 'object' }),
        },
      };
    });
  }
  const toolChoice = canonicalToolChoiceToOpenAi(request.toolChoice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;

  if (isRecord(request.passthrough)) {
    for (const [key, value] of Object.entries(request.passthrough)) {
      if (key === 'transformerMetadata' || body[key] !== undefined) continue;
      body[key] = cloneJsonValue(value);
    }
  }

  return body;
}
