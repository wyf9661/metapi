import { canonicalRequestFromOpenAiBody } from '../../canonical/openAiRequestBridge.js';
import { isCanonicalFunctionTool, isCanonicalNamedToolChoice } from '../../canonical/tools.js';
import type { CanonicalContentPart, CanonicalRequestEnvelope } from '../../canonical/types.js';
import type { ProtocolParseContext } from '../../contracts.js';
import { geminiGenerateContentInbound } from './inbound.js';
import { buildOpenAiBodyFromGeminiRequest } from './compatibility.js';
import {
  reasoningEffortToGeminiThinkingConfig,
  resolveGeminiThinkingConfigFromRequest,
} from './convert.js';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonString(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw };
  }
}

function parseDataUrl(value: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value.trim());
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2],
  };
}

// Dummy sentinel used when no real thoughtSignature is available but thinking
// mode is enabled. Gemini accepts any base64 string and won't reject this.
const DUMMY_THOUGHT_SIGNATURE = 'c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=';

function isDummyThoughtSafeModel(modelName: string): boolean {
  const normalized = asTrimmedString(modelName).toLowerCase();
  return normalized.startsWith('gemini-') || normalized.startsWith('models/gemini-');
}

function parseInlineDataUrl(url: string): { mimeType: string; data: string } | null {
  if (!url.startsWith('data:')) return null;
  const [, rest] = url.split('data:', 2);
  const [meta, data] = rest.split(',', 2);
  if (!meta || !data) return null;
  const [mimeType] = meta.split(';', 1);
  return {
    mimeType: mimeType || 'application/octet-stream',
    data,
  };
}

function normalizeFunctionResponseResult(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function convertOpenAiContentToGeminiParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? [{ text: trimmed }] : [];
  }

  if (isRecord(content)) {
    if (typeof content.text === 'string') {
      const trimmed = content.text.trim();
      return trimmed ? [{ text: trimmed }] : [];
    }
    return [];
  }

  if (!Array.isArray(content)) return [];

  const parts: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const type = asTrimmedString(item.type).toLowerCase();
    if (type === 'text') {
      const text = asTrimmedString(item.text);
      if (text) parts.push({ text });
      continue;
    }
    if (type === 'image_url') {
      const imageUrl = asTrimmedString(item.image_url && isRecord(item.image_url) ? item.image_url.url : item.url);
      const parsed = imageUrl ? parseInlineDataUrl(imageUrl) : null;
      if (parsed) {
        parts.push({
          inlineData: {
            mime_type: parsed.mimeType,
            data: parsed.data,
          },
        });
      }
      continue;
    }
    if (type === 'input_audio') {
      const data = asTrimmedString(item.data);
      if (data) {
        parts.push({
          inlineData: {
            mime_type: 'audio/wav',
            data,
          },
        });
      }
    }
  }
  return parts;
}

function buildGeminiToolsFromOpenAi(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const declarations = tools
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      if (asTrimmedString(item.type) !== 'function' || !isRecord(item.function)) return [];
      const fn = item.function as Record<string, unknown>;
      const name = asTrimmedString(fn.name);
      if (!name) return [];
      return [{
        name,
        ...(asTrimmedString(fn.description) ? { description: asTrimmedString(fn.description) } : {}),
        parametersJsonSchema: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
      }];
    });

  if (declarations.length <= 0) return undefined;
  return [{ functionDeclarations: declarations }];
}

function buildGeminiToolConfigFromOpenAi(toolChoice: unknown): Record<string, unknown> | undefined {
  if (typeof toolChoice === 'string') {
    const normalized = toolChoice.trim().toLowerCase();
    if (normalized === 'none') {
      return { functionCallingConfig: { mode: 'NONE' } };
    }
    if (normalized === 'required') {
      return { functionCallingConfig: { mode: 'ANY' } };
    }
    return { functionCallingConfig: { mode: 'AUTO' } };
  }
  return undefined;
}

export function buildGeminiGenerateContentRequestFromOpenAi(input: {
  body: Record<string, unknown>;
  modelName: string;
  instructions?: string;
}) {
  const request: Record<string, unknown> = {
    contents: [],
  };

  const messages = Array.isArray(input.body.messages) ? input.body.messages : [];
  const toolNameById = new Map<string, string>();
  for (const message of messages) {
    if (!isRecord(message) || asTrimmedString(message.role) !== 'assistant') continue;
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
      const id = asTrimmedString(toolCall.id);
      const name = asTrimmedString(toolCall.function.name);
      if (id && name) {
        toolNameById.set(id, name);
      }
    }
  }

  const hasThinkingEnabled = !!resolveGeminiThinkingConfigFromRequest(input.modelName, input.body);
  const allowsDummyThoughtSignature = isDummyThoughtSafeModel(input.modelName);
  let shouldDisableThinkingConfig = false;

  const thoughtSignatureById = new Map<string, string>();
  for (const message of messages) {
    if (!isRecord(message) || asTrimmedString(message.role) !== 'assistant') continue;
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) continue;
      const id = asTrimmedString(toolCall.id);
      if (!id) continue;
      const providerFields = isRecord(toolCall.provider_specific_fields) ? toolCall.provider_specific_fields : null;
      if (providerFields && typeof providerFields.thought_signature === 'string') {
        thoughtSignatureById.set(id, providerFields.thought_signature);
      }
    }
  }

  const systemParts: Array<Record<string, unknown>> = [];
  if (typeof input.instructions === 'string' && input.instructions.trim()) {
    systemParts.push({ text: input.instructions.trim() });
  }

  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = asTrimmedString(message.role).toLowerCase();
    if (role === 'system' || role === 'developer') {
      systemParts.push(...convertOpenAiContentToGeminiParts(message.content));
      continue;
    }
    if (role === 'tool') {
      const toolCallId = asTrimmedString(message.tool_call_id);
      const name = toolNameById.get(toolCallId) || 'unknown';
      const result = normalizeFunctionResponseResult(message.content);
      request.contents = [
        ...(Array.isArray(request.contents) ? request.contents : []),
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name,
              response: {
                result,
              },
            },
          }],
        },
      ];
      continue;
    }

    const textParts = convertOpenAiContentToGeminiParts(message.content);
    const fcParts: Array<Record<string, unknown>> = [];
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
      const name = asTrimmedString(toolCall.function.name);
      if (!name) continue;
      const rawArguments = toolCall.function.arguments;
      let args: unknown = {};
      if (typeof rawArguments === 'string' && rawArguments.trim()) {
        try {
          args = JSON.parse(rawArguments);
        } catch {
          args = { raw: rawArguments };
        }
      } else if (isRecord(rawArguments)) {
        args = rawArguments;
      }
      const fcPart: Record<string, unknown> = {
        functionCall: { name, args },
      };
      const id = asTrimmedString(toolCall.id);
      const signature = thoughtSignatureById.get(id);
      if (signature) {
        fcPart.thoughtSignature = signature;
      } else if (hasThinkingEnabled && allowsDummyThoughtSignature) {
        fcPart.thoughtSignature = DUMMY_THOUGHT_SIGNATURE;
      } else if (hasThinkingEnabled) {
        shouldDisableThinkingConfig = true;
      }
      fcParts.push(fcPart);
    }

    const geminiRole = role === 'assistant' ? 'model' : 'user';
    const hasSigned = fcParts.some((part) => 'thoughtSignature' in part);
    if (hasSigned && textParts.length > 0 && fcParts.length > 0) {
      request.contents = [
        ...(Array.isArray(request.contents) ? request.contents : []),
        { role: geminiRole, parts: textParts },
        { role: geminiRole, parts: fcParts },
      ];
    } else {
      const allParts = [...textParts, ...fcParts];
      if (allParts.length <= 0) continue;
      request.contents = [
        ...(Array.isArray(request.contents) ? request.contents : []),
        { role: geminiRole, parts: allParts },
      ];
    }
  }

  if (systemParts.length > 0) {
    request.systemInstruction = {
      role: 'user',
      parts: systemParts,
    };
  }

  const generationConfig: Record<string, unknown> = {};
  const maxOutputTokens = Number(
    input.body.max_output_tokens
    ?? input.body.max_completion_tokens
    ?? input.body.max_tokens
    ?? 0,
  );
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    generationConfig.maxOutputTokens = Math.trunc(maxOutputTokens);
  }
  const temperature = Number(input.body.temperature);
  if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
  const topP = Number(input.body.top_p);
  if (Number.isFinite(topP)) generationConfig.topP = topP;
  const topK = Number(input.body.top_k);
  if (Number.isFinite(topK)) generationConfig.topK = topK;
  if (Array.isArray(input.body.stop) && input.body.stop.length > 0) {
    generationConfig.stopSequences = input.body.stop.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  const thinkingConfig = resolveGeminiThinkingConfigFromRequest(input.modelName, input.body);
  if (thinkingConfig && !shouldDisableThinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }
  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig;
  }

  const geminiTools = buildGeminiToolsFromOpenAi(input.body.tools);
  if (geminiTools) {
    request.tools = geminiTools;
  }
  const toolConfig = buildGeminiToolConfigFromOpenAi(input.body.tool_choice);
  if (toolConfig) {
    request.toolConfig = toolConfig;
  }

  return request;
}

function canonicalPartToGeminiPart(
  part: CanonicalContentPart,
  toolNameById?: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  if (part.type === 'text') {
    return {
      text: part.text,
      ...(part.thought === true ? { thought: true } : {}),
    };
  }

  if (part.type === 'image') {
    const source = typeof part.dataUrl === 'string' && part.dataUrl.trim()
      ? part.dataUrl
      : (typeof part.url === 'string' ? part.url : '');
    if (!source) return null;

    const dataUrl = parseDataUrl(source);
    if (dataUrl) {
      return {
        inlineData: {
          mimeType: dataUrl.mimeType,
          data: dataUrl.data,
        },
      };
    }

    return {
      fileData: {
        fileUri: source,
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
      },
    };
  }

  if (part.type === 'file') {
    if (part.fileData) {
      return {
        inlineData: {
          mimeType: part.mimeType || 'application/octet-stream',
          data: part.fileData,
        },
      };
    }

    const fileUri = part.fileUrl || part.fileId;
    if (!fileUri) return null;
    return {
      fileData: {
        fileUri,
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
      },
    };
  }

  if (part.type === 'tool_call') {
    return {
      functionCall: {
        id: part.id,
        name: part.name,
        args: parseJsonString(part.argumentsJson),
      },
    };
  }

  if (part.type === 'tool_result') {
    const response = part.resultJson ?? parseJsonString(part.resultText ?? '');
    return {
      functionResponse: {
        name: toolNameById?.get(part.toolCallId) || 'unknown',
        response: {
          result: response,
        },
      },
    };
  }

  return null;
}

export function buildCanonicalRequestToGeminiGenerateContentBody(
  request: CanonicalRequestEnvelope,
): Record<string, unknown> {
  const contents: Array<Record<string, unknown>> = [];
  const systemParts: Array<Record<string, unknown>> = [];
  const toolNameById = new Map<string, string>();

  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      systemParts.push(
        ...message.parts
          .map((part) => canonicalPartToGeminiPart(part, toolNameById))
          .filter((part): part is Record<string, unknown> => !!part),
      );
      continue;
    }

    for (const part of message.parts) {
      if (part.type === 'tool_call') {
        toolNameById.set(part.id, part.name);
      }
    }

    const parts = message.parts
      .map((part) => canonicalPartToGeminiPart(part, toolNameById))
      .filter((part): part is Record<string, unknown> => !!part);

    if (parts.length <= 0) continue;

    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts,
      });
      continue;
    }

    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts,
    });
  }

  const payload: Record<string, unknown> = {
    contents,
  };

  if (systemParts.length > 0) {
    payload.systemInstruction = {
      role: 'user',
      parts: systemParts,
    };
  }

  const generationConfig: Record<string, unknown> = {};
  if (request.reasoning?.budgetTokens !== undefined) {
    generationConfig.thinkingConfig = {
      thinkingBudget: request.reasoning.budgetTokens,
    };
  } else if (request.reasoning?.effort) {
    generationConfig.thinkingConfig = reasoningEffortToGeminiThinkingConfig(
      request.requestedModel,
      request.reasoning.effort,
    );
  }
  if (Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }

  if (Array.isArray(request.tools) && request.tools.length > 0) {
    const functionTools = request.tools.filter(isCanonicalFunctionTool);
    if (functionTools.length > 0) {
      payload.tools = [{
        functionDeclarations: functionTools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchema ? { parameters: tool.inputSchema } : {}),
        })),
      }];
    }
  }

  if (request.toolChoice) {
    if (request.toolChoice === 'none') {
      payload.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    } else if (request.toolChoice === 'auto') {
      payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    } else if (request.toolChoice === 'required') {
      payload.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    } else if (isCanonicalNamedToolChoice(request.toolChoice)) {
      payload.toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [request.toolChoice.name],
        },
      };
    }
  }

  return payload;
}

export function parseGeminiGenerateContentRequestToCanonical(
  body: unknown,
  ctx?: ProtocolParseContext,
): { value?: CanonicalRequestEnvelope; error?: { statusCode: number; payload: unknown } } {
  const rawBody = isRecord(body) ? body : {};
  const requestedModel = asTrimmedString(rawBody.model ?? ctx?.metadata?.requestedModel);
  if (!requestedModel) {
    return {
      error: {
        statusCode: 400,
        payload: {
          error: {
            message: 'model is required',
            type: 'invalid_request_error',
          },
        },
      },
    };
  }

  const stream = rawBody.stream === true || ctx?.metadata?.stream === true;
  const normalizedBody = geminiGenerateContentInbound.normalizeRequest(rawBody, requestedModel);
  const openAiBody = buildOpenAiBodyFromGeminiRequest({
    body: normalizedBody,
    modelName: requestedModel,
    stream,
  });

  return {
    value: canonicalRequestFromOpenAiBody({
      body: openAiBody,
      surface: 'gemini-generate-content',
      cliProfile: ctx?.cliProfile,
      operation: ctx?.operation,
      metadata: ctx?.metadata,
      passthrough: ctx?.passthrough,
      continuation: ctx?.continuation,
    }),
  };
}
