/**
 * Pure selectors over the transcript state.
 *
 * Decision #2 (blocks are the single source of truth): accumulated strings
 * are derived here, at the edges that need them (persistence, copy actions,
 * legacy consumers) — turns never store them.
 */

import type { AssistantTurnItem, ToolCallView } from './transcript.js';
import type { InteractionRequest } from './interaction.js';
import type { TranscriptState } from './state.js';

/** Concatenated text blocks — the persisted/copyable message body. */
export function turnText(turn: AssistantTurnItem): string {
  let out = '';
  for (const block of turn.blocks) {
    if (block.kind === 'text') out += block.text;
  }
  return out;
}

/** Concatenated thinking blocks. */
export function turnThinking(turn: AssistantTurnItem): string {
  let out = '';
  for (const block of turn.blocks) {
    if (block.kind === 'thinking') out += block.text;
  }
  return out;
}

/** Tool calls in the order they appear in the block stream. */
export function orderedToolCalls(turn: AssistantTurnItem): ToolCallView[] {
  const out: ToolCallView[] = [];
  for (const block of turn.blocks) {
    if (block.kind !== 'tool_call') continue;
    const tool = turn.toolCalls[block.toolCallId];
    if (tool) out.push(tool);
  }
  return out;
}

/** The most recent still-streaming turn, if any. */
export function activeTurn(state: TranscriptState): AssistantTurnItem | null {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.kind === 'assistant_turn') {
      return item.status === 'streaming' ? item : null;
    }
  }
  return null;
}

/** Oldest unresolved blocking interaction (what the host should render now). */
export function pendingInteraction(
  state: TranscriptState,
): InteractionRequest | null {
  return state.interactions[0] ?? null;
}
