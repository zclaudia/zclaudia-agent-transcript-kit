/**
 * Shared transcript view model.
 *
 * This is a RENDERING model, not a wire protocol. Each host app keeps its own
 * wire protocol and writes a thin adapter that translates wire events into
 * `TranscriptEvent`s (see events.ts); a shared reducer folds those into the
 * types below, which the shared UI components consume.
 *
 * Design inputs:
 *  - zclaudia   shared/src/core/message.ts        (ContentBlock / ToolCall)
 *  - intellij   agent-daemon/src/ui/state.ts      (AssistantBlock / PlaygroundToolCall)
 *  - hermes     src/lib/stream-model.ts           (ChatEntry, flat)
 */

/** Open extension slot: host-specific data the kit stores but never interprets. */
export type Ext = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Transcript items
// ---------------------------------------------------------------------------

export type TranscriptItem = UserMessageItem | AssistantTurnItem | MarkerItem;

export interface AttachmentRef {
  /** Host-resolved reference (fileId, URL, data URI, ...). */
  ref: string;
  name?: string;
  mimeType?: string;
  type: 'image' | 'file';
}

export interface UserMessageItem {
  kind: 'user_message';
  id: string;
  text: string;
  attachments?: AttachmentRef[];
  /** True when injected mid-run (steering / redirect) rather than a normal send. */
  steered?: boolean;
  createdAt?: number;
  ext?: Ext;
}

export type TurnStatus = 'streaming' | 'complete' | 'failed' | 'cancelled';

/**
 * One assistant turn: ordered blocks preserving the real text → tool → text
 * interleaving, with tool call detail stored by id alongside.
 */
export interface AssistantTurnItem {
  kind: 'assistant_turn';
  id: string;
  blocks: TurnBlock[];
  /** Keyed by ToolCallView.id; referenced from `tool_call` blocks. */
  toolCalls: Record<string, ToolCallView>;
  status: TurnStatus;
  error?: string;
  model?: string;
  usage?: UsageSummary;
  startedAt?: number;
  completedAt?: number;
  ext?: Ext;
}

export type TurnBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; signature?: string; redacted?: boolean }
  | { kind: 'tool_call'; toolCallId: string };

/**
 * Anything in the timeline that is neither a user message nor an assistant
 * turn: compaction markers, context-usage cards, mode transitions, system
 * notices. Hosts register renderers per `markerType`; unknown types fall back
 * to a generic card (or nothing).
 */
export interface MarkerItem {
  kind: 'marker';
  id: string;
  markerType: string;
  payload?: unknown;
  createdAt?: number;
  ext?: Ext;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export type ToolCallStatus = 'running' | 'success' | 'error' | 'cancelled';

/**
 * Provider-neutral semantic tag so UI never branches on toolName.
 * Open string union: hosts may pass values the kit does not know yet.
 */
export type ToolSemantic =
  | 'plan_proposal'
  | 'plan_enter'
  | 'plan_exit'
  | (string & {});

export interface ToolCallView {
  id: string;
  name: string;
  status: ToolCallStatus;
  input?: unknown;
  result?: unknown;
  errorMessage?: string;
  semantic?: ToolSemantic;
  /** Normalized rendering hint; when absent the UI falls back to generic JSON. */
  presentation?: ToolPresentation;
  /** One-line human summary ("Edited 3 files", "Ran 12s"). */
  summary?: string;
  /** Accumulated streamed progress output (tool_activity), shown while running. */
  activityLog?: string;
  startedAt?: number;
  completedAt?: number;
  ext?: Ext;
}

/**
 * How to render a tool call, decoupled from tool names. Adapters (or a shared
 * classifier utility) map name+input+result into one of these.
 */
export type ToolPresentation =
  | { kind: 'terminal'; command: string; output?: string; exitCode?: number }
  | {
      kind: 'file_edit';
      filePath: string;
      diff?: string;
      changeKind?: 'add' | 'modify' | 'delete' | 'rename';
    }
  | { kind: 'search'; query: string; results: SearchResultView[] }
  | { kind: 'image'; url: string; alt?: string }
  | { kind: 'todo'; todos: TodoItemView[] }
  | { kind: 'generic'; text?: string };

export interface SearchResultView {
  title: string;
  url: string;
  snippet?: string;
}

export interface TodoItemView {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** Real context-window occupancy after this turn, when the host knows it. */
  contextUsedTokens?: number;
}
