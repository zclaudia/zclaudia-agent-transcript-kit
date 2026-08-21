/**
 * Headless transcript reducer: folds normalized TranscriptEvents into
 * renderable state. Immutable, framework-free — hosts wrap it in
 * useReducer / Zustand / anything.
 *
 * Behavior notes:
 * - Idempotent replays: duplicate turn_started / tool_started / marker events
 *   are no-ops, and snapshot text replays merge cleanly (reconnect replay is
 *   a host reality in all three apps).
 * - Implicit turn upsert: stream events for an unknown turnId create the
 *   turn, so a reconnect mid-stream still renders.
 * - tool_activity for an unknown toolCallId is dropped (adapter bug; caught
 *   by assertEvents in dev, never a crash in prod).
 * - Turn end drops that turn's pending interactions and cancels its
 *   still-running tools on failure/cancellation.
 * - Todos (decision #1): latest-wins session state, updated from
 *   tool_finished with a todo presentation and from marker{markerType:
 *   'todo_update'}; the timeline entries render independently.
 */

import type {
  AssistantTurnItem,
  MarkerItem,
  TodoItemView,
  ToolCallView,
  TranscriptItem,
  TurnBlock,
  UserMessageItem,
} from './transcript.js';
import type { InteractionRequest } from './interaction.js';
import type { TranscriptEvent } from './events.js';
import { assertTranscriptEvent } from './guards.js';
import { mergeStreamText } from './text-utils.js';
import { turnText, turnThinking } from './selectors.js';

export interface TranscriptState {
  items: TranscriptItem[];
  /** Unresolved blocking interactions, oldest first. */
  interactions: InteractionRequest[];
  /** Latest-wins session todo list (decision #1). */
  todos: TodoItemView[];
}

export const initialTranscriptState: TranscriptState = {
  items: [],
  interactions: [],
  todos: [],
};

export interface ApplyEventOptions {
  /** Validate every event with assertTranscriptEvent (enable in dev builds). */
  assertEvents?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function newTurn(turnId: string, at?: number, model?: string): AssistantTurnItem {
  return {
    kind: 'assistant_turn',
    id: turnId,
    blocks: [],
    toolCalls: {},
    status: 'streaming',
    startedAt: at,
    model,
  };
}

function upsertTurn(
  state: TranscriptState,
  turnId: string,
  patch: (turn: AssistantTurnItem) => AssistantTurnItem,
): TranscriptState {
  const index = state.items.findIndex(
    item => item.kind === 'assistant_turn' && item.id === turnId,
  );
  if (index < 0) {
    return { ...state, items: [...state.items, patch(newTurn(turnId))] };
  }
  const current = state.items[index] as AssistantTurnItem;
  const next = patch(current);
  if (next === current) return state;
  const items = state.items.slice();
  items[index] = next;
  return { ...state, items };
}

/** Extend the trailing block of the same kind, else start a new one. */
function appendBlock(
  blocks: TurnBlock[],
  kind: 'text' | 'thinking',
  suffix: string,
): TurnBlock[] {
  if (!suffix) return blocks;
  const last = blocks.at(-1);
  if (last && last.kind === kind) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + suffix }];
  }
  return [...blocks, { kind, text: suffix }];
}

function appendStream(
  turn: AssistantTurnItem,
  kind: 'text' | 'thinking',
  event: { delta?: string; snapshot?: string; signature?: string; redacted?: boolean },
): AssistantTurnItem {
  const current = kind === 'text' ? turnText(turn) : turnThinking(turn);
  const merged =
    event.snapshot !== undefined
      ? mergeStreamText(current, event.snapshot, true)
      : mergeStreamText(current, event.delta ?? '', false);
  // mergeStreamText always returns an extension of `current`.
  const suffix = merged.slice(current.length);
  let blocks = appendBlock(turn.blocks, kind, suffix);
  if (kind === 'thinking' && (event.signature !== undefined || event.redacted !== undefined)) {
    const last = blocks.at(-1);
    if (last && last.kind === 'thinking') {
      blocks = [
        ...blocks.slice(0, -1),
        { ...last, signature: event.signature ?? last.signature, redacted: event.redacted ?? last.redacted },
      ];
    }
  }
  if (blocks === turn.blocks) return turn;
  return { ...turn, blocks };
}

function patchTool(
  turn: AssistantTurnItem,
  toolCallId: string,
  patch: (tool: ToolCallView) => ToolCallView,
): AssistantTurnItem {
  const tool = turn.toolCalls[toolCallId];
  if (!tool) return turn;
  const next = patch(tool);
  if (next === tool) return turn;
  return { ...turn, toolCalls: { ...turn.toolCalls, [toolCallId]: next } };
}

function cancelRunningTools(turn: AssistantTurnItem): AssistantTurnItem {
  let changed = false;
  const toolCalls: Record<string, ToolCallView> = {};
  for (const [id, tool] of Object.entries(turn.toolCalls)) {
    if (tool.status === 'running') {
      toolCalls[id] = { ...tool, status: 'cancelled' };
      changed = true;
    } else {
      toolCalls[id] = tool;
    }
  }
  return changed ? { ...turn, toolCalls } : turn;
}

function dropTurnInteractions(
  state: TranscriptState,
  turnId: string,
): TranscriptState {
  const interactions = state.interactions.filter(
    interaction => interaction.turnId !== turnId,
  );
  return interactions.length === state.interactions.length
    ? state
    : { ...state, interactions };
}

function endTurn(
  state: TranscriptState,
  turnId: string,
  patch: (turn: AssistantTurnItem) => AssistantTurnItem,
): TranscriptState {
  return dropTurnInteractions(upsertTurn(state, turnId, patch), turnId);
}

function normalizeTodos(payload: unknown): TodoItemView[] | null {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { todos?: unknown }).todos)
      ? (payload as { todos: unknown[] }).todos
      : null;
  if (!list) return null;
  const todos: TodoItemView[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { content, status } = entry as { content?: unknown; status?: unknown };
    if (typeof content !== 'string') continue;
    todos.push({
      content,
      status:
        status === 'in_progress' || status === 'completed' || status === 'cancelled'
          ? status
          : 'pending',
    });
  }
  return todos;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function applyTranscriptEvent(
  state: TranscriptState,
  event: TranscriptEvent,
  options?: ApplyEventOptions,
): TranscriptState {
  if (options?.assertEvents) assertTranscriptEvent(event);

  switch (event.type) {
    case 'turn_started': {
      const exists = state.items.some(
        item => item.kind === 'assistant_turn' && item.id === event.turnId,
      );
      if (exists) return state;
      return {
        ...state,
        items: [...state.items, newTurn(event.turnId, event.at, event.model)],
      };
    }

    case 'text_delta':
      return upsertTurn(state, event.turnId, turn =>
        appendStream(turn, 'text', event),
      );

    case 'thinking_delta':
      return upsertTurn(state, event.turnId, turn =>
        appendStream(turn, 'thinking', event),
      );

    case 'tool_started':
      return upsertTurn(state, event.turnId, turn => {
        if (turn.toolCalls[event.toolCallId]) return turn;
        const tool: ToolCallView = {
          id: event.toolCallId,
          name: event.name,
          status: 'running',
          input: event.input,
          semantic: event.semantic,
          startedAt: event.at,
        };
        return {
          ...turn,
          toolCalls: { ...turn.toolCalls, [tool.id]: tool },
          blocks: [...turn.blocks, { kind: 'tool_call', toolCallId: tool.id }],
        };
      });

    case 'tool_activity':
      return upsertTurn(state, event.turnId, turn =>
        patchTool(turn, event.toolCallId, tool => ({
          ...tool,
          summary: event.summary ?? tool.summary,
          activityLog: event.outputDelta
            ? (tool.activityLog ?? '') + event.outputDelta
            : tool.activityLog,
        })),
      );

    case 'tool_finished': {
      const next = upsertTurn(state, event.turnId, turn => {
        // Create-if-missing: some wires only emit a completion event.
        const base = turn.toolCalls[event.toolCallId]
          ? turn
          : {
              ...turn,
              toolCalls: {
                ...turn.toolCalls,
                [event.toolCallId]: {
                  id: event.toolCallId,
                  name: '',
                  status: 'running' as const,
                },
              },
              blocks: [
                ...turn.blocks,
                { kind: 'tool_call' as const, toolCallId: event.toolCallId },
              ],
            };
        return patchTool(base, event.toolCallId, tool => ({
          ...tool,
          status: event.isError ? 'error' : 'success',
          result: event.result ?? tool.result,
          errorMessage: event.errorMessage ?? tool.errorMessage,
          presentation: event.presentation ?? tool.presentation,
          summary: event.summary ?? tool.summary,
          completedAt: event.at,
        }));
      });
      if (event.presentation?.kind === 'todo') {
        return { ...next, todos: event.presentation.todos };
      }
      return next;
    }

    case 'turn_finished':
      return endTurn(state, event.turnId, turn => ({
        ...turn,
        status: 'complete',
        usage: event.usage ?? turn.usage,
        completedAt: event.at,
      }));

    case 'turn_failed':
      return endTurn(state, event.turnId, turn => ({
        ...cancelRunningTools(turn),
        status: 'failed',
        error: event.error,
        completedAt: event.at,
      }));

    case 'turn_cancelled':
      return endTurn(state, event.turnId, turn => ({
        ...cancelRunningTools(turn),
        status: 'cancelled',
        completedAt: event.at,
      }));

    case 'interaction_requested': {
      const index = state.interactions.findIndex(
        interaction => interaction.id === event.request.id,
      );
      if (index < 0) {
        return { ...state, interactions: [...state.interactions, event.request] };
      }
      const interactions = state.interactions.slice();
      interactions[index] = event.request;
      return { ...state, interactions };
    }

    case 'interaction_resolved': {
      const interactions = state.interactions.filter(
        interaction => interaction.id !== event.interactionId,
      );
      return interactions.length === state.interactions.length
        ? state
        : { ...state, interactions };
    }

    case 'marker': {
      const exists = state.items.some(
        item => item.kind === 'marker' && item.id === event.markerId,
      );
      if (exists) return state;
      const marker: MarkerItem = {
        kind: 'marker',
        id: event.markerId,
        markerType: event.markerType,
        payload: event.payload,
        createdAt: event.at,
      };
      const next = { ...state, items: [...state.items, marker] };
      if (event.markerType === 'todo_update') {
        const todos = normalizeTodos(event.payload);
        if (todos) return { ...next, todos };
      }
      return next;
    }
  }
}

/** Host-side append for optimistic user sends (not part of the event stream). */
export function appendUserMessage(
  state: TranscriptState,
  message: UserMessageItem,
): TranscriptState {
  return { ...state, items: [...state.items, message] };
}
