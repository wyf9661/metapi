import { TextDecoder, TextEncoder } from 'node:util';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function wrapGeminiCliRequest(input: {
  modelName: string;
  projectId: string;
  request: Record<string, unknown>;
}) {
  const { model: _model, ...requestPayload } = input.request;
  return {
    project: input.projectId,
    model: input.modelName,
    request: requestPayload,
  };
}

export function unwrapGeminiCliPayload<T>(payload: T): unknown {
  if (!isRecord(payload)) return payload;
  if (payload.response !== undefined) {
    return payload.response;
  }
  return payload;
}

function rewriteGeminiCliSseEventBlock(block: string): string {
  const lines = block.split(/\r?\n/g);
  return lines.map((line) => {
    if (!line.startsWith('data:')) return line;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return line;
    try {
      const parsed = JSON.parse(data);
      return `data: ${JSON.stringify(unwrapGeminiCliPayload(parsed))}`;
    } catch {
      return line;
    }
  }).join('\n');
}

export function createGeminiCliStreamReader(reader: {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const outputQueue: Uint8Array[] = [];
  let buffer = '';
  let done = false;

  async function fillQueue() {
    while (outputQueue.length <= 0 && !done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        const tail = decoder.decode();
        if (tail) buffer += tail;
        if (buffer.trim()) {
          outputQueue.push(encoder.encode(`${rewriteGeminiCliSseEventBlock(buffer)}\n\n`));
          buffer = '';
        }
        break;
      }
      if (!result.value) continue;
      buffer += decoder.decode(result.value, { stream: true });
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        outputQueue.push(encoder.encode(`${rewriteGeminiCliSseEventBlock(block)}\n\n`));
        separatorIndex = buffer.indexOf('\n\n');
      }
    }
  }

  return {
    async read() {
      await fillQueue();
      if (outputQueue.length > 0) {
        return { done: false, value: outputQueue.shift() };
      }
      return { done: true, value: undefined };
    },
    cancel(reason?: unknown) {
      return reader.cancel(reason);
    },
    releaseLock() {
      reader.releaseLock();
    },
  };
}
