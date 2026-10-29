/**
 * OpenAI tool-call `index` assignment for streamed (and non-streamed) tool calls.
 *
 * Shared by the openai/chat stream path and the format-normalizing core so both agree
 * on what a fragment without an `index` means.
 */

export type ToolCallIndexState = {
  /** Slot the current call's later fragments belong to. */
  activeIndex: number;
  /** Next unused slot, handed out when a fresh call opens. */
  nextIndex: number;
  /** slot -> call id, so a fragment that repeats an earlier id rejoins that slot. */
  idByIndex: Map<number, string>;
};

export function createToolCallIndexState(): ToolCallIndexState {
  return { activeIndex: 0, nextIndex: 0, idByIndex: new Map() };
}

/**
 * Pick the OpenAI `index` for one tool-call fragment.
 *
 * An explicit `index` always wins. Without one, the fragment must NOT be given the array
 * position: upstreams routinely put several argument fragments of the SAME call into one
 * `tool_calls` array with no index and no id, and numbering those 0..n hands the client n
 * parallel calls that each hold a JSON fragment — every one unparseable, so the whole turn
 * reads as a truncated tool call and the real call is lost. Slot assignment therefore
 * follows call identity instead:
 *   - fragment repeats the active call's id, or is a bare argument fragment with no id and
 *     no name -> continue the active slot;
 *   - fragment carries a name, or an unseen id, -> open a new slot;
 *   - fragment repeats an id an earlier slot owns -> rejoin that slot.
 */
export function resolveToolCallIndex(
  explicitIndex: number | undefined,
  id: string | undefined,
  name: string | undefined,
  state: ToolCallIndexState,
): number {
  if (explicitIndex !== undefined) {
    const slot = Math.max(0, Math.trunc(explicitIndex));
    state.activeIndex = slot;
    state.nextIndex = Math.max(state.nextIndex, slot + 1);
    if (id) state.idByIndex.set(slot, id);
    return slot;
  }
  const owner = id
    ? [...state.idByIndex.entries()].find(([, existingId]) => existingId === id)?.[0]
    : undefined;
  if (owner !== undefined) {
    state.activeIndex = owner;
    return owner;
  }
  // A name opens a call; so does an id the active slot has not claimed yet. A bare
  // argument fragment continues the active call — treating it as a new one is exactly
  // what shredded these streams into per-fragment "parallel" calls.
  const opensCall = !!name || (!!id && state.idByIndex.get(state.activeIndex) !== id);
  if (!opensCall) return state.activeIndex;
  const fresh = state.nextIndex;
  state.nextIndex += 1;
  state.activeIndex = fresh;
  if (id) state.idByIndex.set(fresh, id);
  return fresh;
}
