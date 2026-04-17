function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const CODEX_DEFAULT_INSTRUCTIONS = 'You are a helpful coding assistant.';

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => extractTextFromContent(item))
      .filter((item) => item.length > 0)
      .join('');
  }
  if (!isRecord(content)) return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;
  if (typeof content.output_text === 'string') return content.output_text;
  if (typeof content.input_text === 'string') return content.input_text;
  return '';
}

function extractSystemMessagesToInstructions(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.input) || body.input.length <= 0) return body;

  const extractedSystemTexts: string[] = [];
  const remainingInput: unknown[] = [];

  for (const item of body.input) {
    if (!isRecord(item)) {
      remainingInput.push(item);
      continue;
    }
    if (asTrimmedString(item.type).toLowerCase() !== 'message') {
      remainingInput.push(item);
      continue;
    }
    if (asTrimmedString(item.role).toLowerCase() !== 'system') {
      remainingInput.push(item);
      continue;
    }

    const text = extractTextFromContent(item.content);
    if (text.trim()) {
      extractedSystemTexts.push(text);
    }
  }

  if (extractedSystemTexts.length <= 0) return body;

  const extractedInstructions = extractedSystemTexts.join('\n\n');
  const existingInstructions = typeof body.instructions === 'string' ? body.instructions : '';
  const nextInstructions = existingInstructions.trim()
    ? `${extractedInstructions}\n\n${existingInstructions}`
    : extractedInstructions;

  return {
    ...body,
    input: remainingInput,
    instructions: nextInstructions,
  };
}

function ensureCodexResponsesInstructions(
  body: Record<string, unknown>,
  sitePlatform: string,
): Record<string, unknown> {
  if (sitePlatform !== 'codex') return body;
  if (typeof body.instructions === 'string' && body.instructions.trim()) return body;
  return {
    ...body,
    instructions: CODEX_DEFAULT_INSTRUCTIONS,
  };
}

function ensureCodexResponsesStoreFalse(
  body: Record<string, unknown>,
  sitePlatform: string,
): Record<string, unknown> {
  if (sitePlatform !== 'codex') return body;
  return {
    ...body,
    store: false,
  };
}

function stripCodexUnsupportedResponsesFields(
  body: Record<string, unknown>,
  sitePlatform: string,
): Record<string, unknown> {
  if (sitePlatform !== 'codex') return body;
  const next = { ...body };
  delete next.max_output_tokens;
  delete next.max_completion_tokens;
  delete next.max_tokens;
  return next;
}

function applyCodexResponsesCompatibility(
  body: Record<string, unknown>,
  sitePlatform: string,
): Record<string, unknown> {
  if (sitePlatform !== 'codex') return body;
  return extractSystemMessagesToInstructions(body);
}

export function normalizeCodexResponsesBodyForProxy(
  body: Record<string, unknown>,
  sitePlatform: string,
): Record<string, unknown> {
  if (sitePlatform !== 'codex') return body;
  return ensureCodexResponsesStoreFalse(
    stripCodexUnsupportedResponsesFields(
      ensureCodexResponsesInstructions(
        applyCodexResponsesCompatibility(body, sitePlatform),
        sitePlatform,
      ),
      sitePlatform,
    ),
    sitePlatform,
  );
}
