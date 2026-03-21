import { normalizeInputFileBlock } from '../../shared/inputFile.js';
import { resolveGeminiThinkingConfigFromRequest } from './convert.js';

const DUMMY_THOUGHT_SIGNATURE = 'c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
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

function toGeminiInlineDataPart(input: {
  mimeType: string;
  data: string;
}): Record<string, unknown> {
  return {
    inlineData: {
      mime_type: input.mimeType,
      data: input.data,
    },
  };
}

function convertContentToGeminiParts(content: unknown): Array<Record<string, unknown>> {
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
    if (type === 'image_url' || type === 'input_image') {
      const imageUrl = asTrimmedString(item.image_url && isRecord(item.image_url) ? item.image_url.url : item.image_url ?? item.url);
      const parsed = imageUrl ? parseDataUrl(imageUrl) : null;
      if (parsed) {
        parts.push(toGeminiInlineDataPart(parsed));
        continue;
      }
      if (imageUrl) {
        parts.push({
          fileData: {
            fileUri: imageUrl,
          },
        });
      }
      continue;
    }
    if (type === 'input_audio') {
      const audio = isRecord(item.input_audio) ? item.input_audio : item;
      const data = asTrimmedString(audio.data);
      if (data) {
        parts.push(toGeminiInlineDataPart({
          mimeType: asTrimmedString(audio.mime_type ?? audio.mimeType) || 'audio/wav',
          data,
        }));
      }
      continue;
    }

    const normalizedFile = normalizeInputFileBlock(item);
    if (normalizedFile) {
      if (normalizedFile.fileData) {
        const parsed = parseDataUrl(normalizedFile.fileData);
        parts.push(toGeminiInlineDataPart({
          mimeType: normalizedFile.mimeType || parsed?.mimeType || 'application/octet-stream',
          data: parsed?.data || normalizedFile.fileData,
        }));
        continue;
      }

      const fileUri = normalizedFile.fileUrl || normalizedFile.fileId;
      if (fileUri) {
        parts.push({
          fileData: {
            fileUri,
            ...(normalizedFile.mimeType ? { mimeType: normalizedFile.mimeType } : {}),
          },
        });
      }
    }
  }
  return parts;
}

function buildGeminiTools(tools: unknown): Array<Record<string, unknown>> | undefined {
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

function buildGeminiToolConfig(toolChoice: unknown): Record<string, unknown> | undefined {
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

export function convertOpenAiBodyToGeminiGenerateContentRequest(input: {
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
      systemParts.push(...convertContentToGeminiParts(message.content));
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

    const textParts = convertContentToGeminiParts(message.content);
    const functionCallParts: Array<Record<string, unknown>> = [];
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
      const functionCallPart: Record<string, unknown> = {
        functionCall: { name, args },
      };
      const id = asTrimmedString(toolCall.id);
      const signature = thoughtSignatureById.get(id);
      if (signature) {
        functionCallPart.thoughtSignature = signature;
      } else if (hasThinkingEnabled) {
        functionCallPart.thoughtSignature = DUMMY_THOUGHT_SIGNATURE;
      }
      functionCallParts.push(functionCallPart);
    }

    const geminiRole = role === 'assistant' ? 'model' : 'user';
    const hasSigned = functionCallParts.some((part) => 'thoughtSignature' in part);
    if (hasSigned && textParts.length > 0 && functionCallParts.length > 0) {
      request.contents = [
        ...(Array.isArray(request.contents) ? request.contents : []),
        { role: geminiRole, parts: textParts },
        { role: geminiRole, parts: functionCallParts },
      ];
    } else {
      const allParts = [...textParts, ...functionCallParts];
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
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }
  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig;
  }

  const geminiTools = buildGeminiTools(input.body.tools);
  if (geminiTools) {
    request.tools = geminiTools;
  }
  const toolConfig = buildGeminiToolConfig(input.body.tool_choice);
  if (toolConfig) {
    request.toolConfig = toolConfig;
  }

  return request;
}
