/**
 * Anthropic `tool_use.input` must be a JSON object. Upstreams sometimes truncate the tool
 * arguments (cut stream, provider bug), and the gateway used to wrap the raw text as
 * `{ value: "<broken json>" }`. The client then ran the tool with a parameter called "value"
 * and no real arguments — a silently wrong call that looks successful.
 *
 * Repair the common truncation shape (missing closing quote/bracket, trailing comma) and
 * otherwise fall back to `{}`, which fails loudly on required parameters instead of
 * pretending the call had arguments.
 */

const MAX_REPAIR_LENGTH = 100_000;

function closeUnbalanced(text: string): string {
  let out = text.trimEnd();
  if (out.endsWith(',') || out.endsWith(':')) out = out.slice(0, -1);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of out) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') stack.pop();
  }
  if (inString) {
    // A truncated string keeps whatever was captured; closing the quote is the best guess.
    out += '"';
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    out += stack[i] === '{' ? '}' : ']';
  }
  return out;
}

export function parseToolUseInput(rawArguments: string): Record<string, unknown> {
  const raw = typeof rawArguments === 'string' ? rawArguments.trim() : '';
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    if (raw.length > MAX_REPAIR_LENGTH) return {};
  }

  try {
    const repaired = JSON.parse(closeUnbalanced(raw));
    return repaired && typeof repaired === 'object' && !Array.isArray(repaired)
      ? repaired as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
