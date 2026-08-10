export type ThinkTagParserState = {
  mode: 'content' | 'reasoning';
  pending: string;
};

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

function trailingPrefixLength(value: string, prefix: string): number {
  const maxLength = Math.min(value.length, prefix.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (prefix.startsWith(value.slice(-length))) {
      return length;
    }
  }
  return 0;
}

function consumeChunkAgainstTag(
  source: string,
  tag: string,
  _target: 'content' | 'reasoning',
): { emitted: string; rest: string; matched: boolean } {
  const sourceLower = source.toLowerCase();
  const tagIndex = sourceLower.indexOf(tag);
  if (tagIndex >= 0) {
    return {
      emitted: source.slice(0, tagIndex),
      rest: source.slice(tagIndex + tag.length),
      matched: true,
    };
  }

  const pendingLength = trailingPrefixLength(sourceLower, tag);
  return {
    emitted: source.slice(0, source.length - pendingLength),
    rest: source.slice(source.length - pendingLength),
    matched: false,
  };
}

export function createThinkTagParserState(): ThinkTagParserState {
  return {
    mode: 'content',
    pending: '',
  };
}

export function consumeThinkTaggedText(
  state: ThinkTagParserState,
  chunk: string,
): { content: string; reasoning: string } {
  if (!chunk) {
    return { content: '', reasoning: '' };
  }

  let content = '';
  let reasoning = '';
  let rest = `${state.pending}${chunk}`;
  state.pending = '';

  while (rest.length > 0) {
    const currentTag = state.mode === 'content' ? OPEN_TAG : CLOSE_TAG;
    const consumed = consumeChunkAgainstTag(rest, currentTag, state.mode);
    if (state.mode === 'content') {
      content += consumed.emitted;
    } else {
      reasoning += consumed.emitted;
    }

    if (!consumed.matched) {
      state.pending = consumed.rest;
      break;
    }

    rest = consumed.rest;
    state.mode = state.mode === 'content' ? 'reasoning' : 'content';
  }

  return { content, reasoning };
}

export function flushThinkTaggedText(state: ThinkTagParserState): { content: string; reasoning: string } {
  if (!state.pending) {
    return { content: '', reasoning: '' };
  }

  const remainder = state.pending;
  state.pending = '';
  return state.mode === 'content'
    ? { content: remainder, reasoning: '' }
    : { content: '', reasoning: remainder };
}

export function extractInlineThinkTags(text: string): { content: string; reasoning: string } {
  if (!text) {
    return { content: '', reasoning: '' };
  }

  const state = createThinkTagParserState();
  const consumed = consumeThinkTaggedText(state, text);
  const flushed = flushThinkTaggedText(state);
  return {
    content: `${consumed.content}${flushed.content}`,
    reasoning: `${consumed.reasoning}${flushed.reasoning}`,
  };
}
