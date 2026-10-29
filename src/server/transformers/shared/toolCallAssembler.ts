/**
 * The single tool-call assembly path.
 *
 * Before this module the same job was done four ways (index assignment) and nine ways
 * (argument concatenation) across the transformers, and one slot could hold an
 * accumulating buffer while another code path compared it against a cumulative upstream
 * snapshot. Those two conventions cannot coexist in one cell: `existing + delta` applied to
 * a value that is already the full snapshot appends everything twice, which is how a
 * well-formed call turns into unparseable JSON.
 *
 * The rule enforced here, in one place:
 *   - a slot is opened once, by the fragment that carries an id or a name;
 *   - argument fragments are appended in arrival order;
 *   - a snapshot (a `*.done` / `completed` frame that carries the whole payload) REPLACES
 *     the assembled buffer instead of extending it, and later fragments append to it;
 *   - `finalize()` derives the wire value exactly once and says whether it parses.
 *
 * Index assignment delegates to `toolCallIndex.ts`, so a missing upstream index can never
 * be mistaken for "a new parallel call at this array position".
 */
import { createToolCallIndexState, resolveToolCallIndex, type ToolCallIndexState } from './toolCallIndex.js';

export type ToolCallSlot = {
  id?: string;
  name?: string;
  /** Assembled argument JSON. */
  arguments: string;
  /** True once a cumulative snapshot replaced the buffer. */
  fromSnapshot: boolean;
};

export type ToolCallAssembly = {
  slots: Record<number, ToolCallSlot>;
  /** Order slots were opened in — the wire order clients should see. */
  order: number[];
};

export function createToolCallAssembly(): ToolCallAssembly {
  return { slots: {}, order: [] };
}

export type ToolCallFragment = {
  /** Upstream-provided index, when it gave a trustworthy one. */
  index?: number;
  id?: string;
  name?: string;
  /** Incremental argument text (may be a fragment or, with `snapshot`, the whole thing). */
  argumentsDelta?: string;
};

/** Owns the index state machine for one stream (one assembly). */
export type ToolCallAssembler = ToolCallAssembly & { indexState: ToolCallIndexState };

export function createToolCallAssembler(): ToolCallAssembler {
  return { ...createToolCallAssembly(), indexState: createToolCallIndexState() };
}

function ensureSlot(assembly: ToolCallAssembly, index: number): ToolCallSlot {
  let slot = assembly.slots[index];
  if (!slot) {
    slot = { arguments: '', fromSnapshot: false };
    assembly.slots[index] = slot;
    assembly.order.push(index);
  }
  return slot;
}

/**
 * Feed one fragment. `snapshot: true` marks a frame that carries the complete argument
 * payload (e.g. `response.output_item.done`, `custom_tool_call_input.done`): it replaces
 * the buffer, so a delta arriving after it still extends rather than duplicating.
 *
 * Returns the slot index the fragment landed in, or `null` when it carried nothing.
 */
export function applyToolCallFragment(
  assembler: ToolCallAssembler,
  fragment: ToolCallFragment,
  options: { snapshot?: boolean } = {},
): number | null {
  const hasArgs = typeof fragment.argumentsDelta === 'string' && fragment.argumentsDelta.length > 0;
  if (!fragment.id && !fragment.name && !hasArgs) return null;

  const index = resolveToolCallIndex(
    typeof fragment.index === 'number' && Number.isFinite(fragment.index) ? fragment.index : undefined,
    fragment.id,
    fragment.name,
    assembler.indexState,
  );
  const slot = ensureSlot(assembler, index);

  if (fragment.id) slot.id = fragment.id;
  if (fragment.name) slot.name = fragment.name;

  if (hasArgs) {
    if (options.snapshot) {
      slot.arguments = fragment.argumentsDelta as string;
      slot.fromSnapshot = true;
    } else {
      slot.arguments += fragment.argumentsDelta;
    }
  }
  return index;
}

export type AssembledToolCall = {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
  /** Whether `arguments` is valid JSON (an empty string counts as an empty object). */
  parses: boolean;
};

/**
 * Derive the wire shape once. `parses: false` is the signal a caller must not forward an
 * unparseable call as if it were valid; repairing it is a policy decision, not this module's.
 */
export function finalizeToolCalls(assembler: ToolCallAssembly): AssembledToolCall[] {
  return assembler.order.map((index) => {
    const slot = assembler.slots[index];
    const raw = slot.arguments || '';
    let parses = true;
    if (raw.trim()) {
      try {
        JSON.parse(raw);
      } catch {
        parses = false;
      }
    }
    return {
      index,
      ...(slot.id ? { id: slot.id } : {}),
      ...(slot.name ? { name: slot.name } : {}),
      arguments: raw,
      parses,
    };
  });
}
