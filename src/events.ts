/**
 * Normalized streaming events — the adapter contract.
 *
 * Each host translates its own wire protocol into this stream; the shared
 * reducer (layer 2) folds it into TranscriptItem[]. Session routing, seq/gap
 * detection and reconnect reconciliation stay HOST-SIDE: by the time events
 * reach this layer they are already attributed to one transcript and ordered.
 *
 * Text/thinking events carry either `delta` (append) or `snapshot` (full
 * replacement) so all three hosts fit without re-deriving suffixes:
 * hermes/zclaudia emit deltas; intellij's legacy providers emit final
 * snapshots after deltas (see mergeAssistantContent in its state.ts).
 */

import type {
  ToolPresentation,
  ToolSemantic,
  UsageSummary,
} from './transcript.js';
import type {
  InteractionRequest,
  InteractionResolvedReason,
} from './interaction.js';

export type TranscriptEvent =
  | { type: 'turn_started'; turnId: string; model?: string; at?: number }
  | { type: 'text_delta'; turnId: string; delta?: string; snapshot?: string }
  | {
      type: 'thinking_delta';
      turnId: string;
      delta?: string;
      snapshot?: string;
      signature?: string;
      redacted?: boolean;
    }
  | {
      type: 'tool_started';
      turnId: string;
      toolCallId: string;
      /**
       * Omitted when the provider announces a call before naming it, or when
       * the caller only means to place the call in the block order. A later
       * tool_started fills it in.
       */
      name?: string;
      input?: unknown;
      semantic?: ToolSemantic;
      at?: number;
    }
  | {
      /** Progress / activity while running (terminal output chunks, status lines). */
      type: 'tool_activity';
      turnId: string;
      toolCallId: string;
      summary?: string;
      outputDelta?: string;
    }
  | {
      type: 'tool_finished';
      turnId: string;
      toolCallId: string;
      result?: unknown;
      isError?: boolean;
      errorMessage?: string;
      presentation?: ToolPresentation;
      summary?: string;
      at?: number;
    }
  | {
      type: 'turn_finished';
      turnId: string;
      usage?: UsageSummary;
      at?: number;
    }
  | { type: 'turn_failed'; turnId: string; error: string; at?: number }
  | { type: 'turn_cancelled'; turnId: string; at?: number }
  | { type: 'interaction_requested'; request: InteractionRequest }
  | {
      type: 'interaction_resolved';
      interactionId: string;
      reason: InteractionResolvedReason;
    }
  | {
      type: 'marker';
      markerId: string;
      markerType: string;
      payload?: unknown;
      at?: number;
    };
