import { normalizeInputFileBlock, toResponsesInputFileBlock } from '../../shared/inputFile.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toTextBlockType(role: string): 'input_text' | 'output_text' {
  return role === 'assistant' ? 'output_text' : 'input_text';
}

function normalizeImageUrlValue(value: unknown): string | Record<string, unknown> | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (!isRecord(value)) return null;
  const url = asTrimmedString(value.url);
  if (url) return { ...value, url };
  const imageUrl = asTrimmedString(value.image_url);
  if (imageUrl) return imageUrl;
  return Object.keys(value).length > 0 ? value : null;
}

function normalizeAudioInputValue(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const data = asTrimmedString(value.data);
  const format = asTrimmedString(value.format);
  if (!data && !format) return Object.keys(value).length > 0 ? value : null;
  return {
    ...value,
    ...(data ? { data } : {}),
    ...(format ? { format } : {}),
  };
}

function normalizeResponsesContentItem(
  item: unknown,
  role: string,
): Record<string, unknown> | null {
  if (typeof item === 'string') {
    const text = item.trim();
    return text ? { type: toTextBlockType(role), text } : null;
  }

  if (!isRecord(item)) return null;

  const type = asTrimmedString(item.type).toLowerCase();
  if (!type) {
    const text = asTrimmedString(item.text ?? item.content ?? item.output_text);
    return text ? { type: toTextBlockType(role), text } : null;
  }

  if (type === 'input_text' || type === 'output_text' || type === 'text') {
    const text = asTrimmedString(item.text ?? item.content ?? item.output_text);
    if (!text) return null;
    return {
      ...item,
      type: type === 'text' ? toTextBlockType(role) : type,
      text,
    };
  }

  if (type === 'input_image' || type === 'image_url') {
    const imageUrl = normalizeImageUrlValue(item.image_url ?? item.url);
    if (!imageUrl) return null;
    return {
      ...item,
      type: 'input_image',
      image_url: imageUrl,
    };
  }

  if (type === 'input_audio') {
    const inputAudio = normalizeAudioInputValue(item.input_audio);
    if (!inputAudio) return null;
    return {
      ...item,
      type: 'input_audio',
      input_audio: inputAudio,
    };
  }

  if (type === 'file' || type === 'input_file') {
    const fileBlock = normalizeInputFileBlock(item);
    return fileBlock ? toResponsesInputFileBlock(fileBlock) : null;
  }

  if (type === 'function_call' || type === 'function_call_output') {
    return item;
  }

  return item;
}

export function normalizeResponsesMessageContent(
  content: unknown,
  role: string,
): unknown {
  if (Array.isArray(content)) {
    const normalized = content
      .map((item) => normalizeResponsesContentItem(item, role))
      .filter((item): item is Record<string, unknown> => !!item);
    return normalized.length > 0 ? normalized : content;
  }

  const single = normalizeResponsesContentItem(content, role);
  if (single) return [single];
  return content;
}

function toResponsesInputMessageFromText(text: string): Record<string, unknown> {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

export function normalizeResponsesMessageItem(item: Record<string, unknown>): Record<string, unknown> {
  const type = asTrimmedString(item.type).toLowerCase();
  if (type === 'function_call' || type === 'function_call_output') {
    return item;
  }

  const role = asTrimmedString(item.role).toLowerCase() || 'user';
  const normalizedContent = normalizeResponsesMessageContent(item.content ?? item.text, role);

  if (type === 'message') {
    return {
      ...item,
      role,
      content: normalizedContent,
    };
  }

  if (asTrimmedString(item.role)) {
    return {
      type: 'message',
      role,
      content: normalizedContent,
    };
  }

  if (typeof item.content === 'string') {
    const text = item.content.trim();
    return text ? toResponsesInputMessageFromText(text) : item;
  }

  return item;
}

export function normalizeResponsesInputForCompatibility(input: unknown): unknown {
  if (typeof input === 'string') {
    const normalized = input.trim();
    if (!normalized) return input;
    return [toResponsesInputMessageFromText(normalized)];
  }

  if (Array.isArray(input)) {
    return input.map((item) => {
      if (typeof item === 'string') {
        const normalized = item.trim();
        return normalized ? toResponsesInputMessageFromText(normalized) : item;
      }
      if (!isRecord(item)) return item;
      return normalizeResponsesMessageItem(item);
    });
  }

  if (isRecord(input)) {
    return [normalizeResponsesMessageItem(input)];
  }

  return input;
}

export function normalizeResponsesMessageContentBlocks(
  role: string,
  content: unknown,
): Array<Record<string, unknown>> {
  const normalized = normalizeResponsesMessageItem({
    type: 'message',
    role,
    content,
  });

  if (isRecord(normalized) && Array.isArray(normalized.content)) {
    return normalized.content.filter((item): item is Record<string, unknown> => isRecord(item));
  }

  return [];
}
