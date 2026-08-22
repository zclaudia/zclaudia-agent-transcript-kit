/**
 * Framework-free delta batching: coalesce streaming events into one reducer
 * commit per animation frame (or 16ms window off-browser).
 *
 * Every delta would otherwise re-render the entire growing turn through
 * markdown; at fast streaming rates the render queue backs up past the end of
 * the run and text keeps "typing" after the spinner is gone. Hosts put this
 * between their adapter and applyTranscriptEvent.
 *
 * Ordering is preserved: only adjacent compatible delta events merge, and any
 * lifecycle event (tool_finished, turn_finished, interactions, ...) flushes
 * the whole queue synchronously so state is current before finalization.
 *
 * Design inputs:
 *  - zclaudia  message-handlers/delta-buffer.ts (rAF coalescing, sync flush
 *              before terminal events, snapshot-before-commit re-entrancy)
 *  - intellij  agent-daemon transport           (16ms batch window)
 */

import type { TranscriptEvent } from './events.js';

export interface TranscriptBatcherOptions {
  /** Receives each batch, oldest first — typically feeds applyTranscriptEvent. */
  onFlush: (events: TranscriptEvent[]) => void;
  /**
   * Custom scheduler (tests, embedders). Default: requestAnimationFrame when
   * available, else setTimeout(16).
   */
  schedule?: (flush: () => void) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface TranscriptBatcher {
  push(event: TranscriptEvent): void;
  /** Deliver everything queued now (before persistence, on visibility change). */
  flush(): void;
  /** Flush the remainder and cancel the pending tick. */
  dispose(): void;
}

function defaultSchedule(flush: () => void): unknown {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(flush);
  return setTimeout(flush, 16);
}

function defaultCancel(handle: unknown): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle as number);
  else clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/** Merge `event` into the queue tail when both are compatible delta events. */
function coalesce(tail: TranscriptEvent | undefined, event: TranscriptEvent): TranscriptEvent | null {
  if (!tail || tail.type !== event.type) return null;
  if (
    (event.type === 'text_delta' || event.type === 'thinking_delta') &&
    (tail.type === 'text_delta' || tail.type === 'thinking_delta')
  ) {
    if (tail.turnId !== event.turnId) return null;
    // Snapshots replace rather than append — never merged.
    if (tail.snapshot !== undefined || event.snapshot !== undefined) return null;
    return { ...tail, ...event, delta: (tail.delta ?? '') + (event.delta ?? '') };
  }
  if (event.type === 'tool_activity' && tail.type === 'tool_activity') {
    if (tail.turnId !== event.turnId || tail.toolCallId !== event.toolCallId) return null;
    const merged: TranscriptEvent = {
      ...tail,
      outputDelta: (tail.outputDelta ?? '') + (event.outputDelta ?? ''),
    };
    if (event.summary !== undefined) merged.summary = event.summary;
    return merged;
  }
  return null;
}

function isDeltaEvent(event: TranscriptEvent): boolean {
  return (
    event.type === 'text_delta' ||
    event.type === 'thinking_delta' ||
    event.type === 'tool_activity'
  );
}

export function createTranscriptBatcher(options: TranscriptBatcherOptions): TranscriptBatcher {
  const schedule = options.schedule ?? defaultSchedule;
  const cancel = options.cancel ?? defaultCancel;
  let queue: TranscriptEvent[] = [];
  let handle: unknown = null;

  const flush = (): void => {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
    if (queue.length === 0) return;
    // Swap before delivering so events pushed synchronously from onFlush
    // start a fresh batch instead of being lost or re-delivered.
    const batch = queue;
    queue = [];
    options.onFlush(batch);
  };

  const onTick = (): void => {
    handle = null;
    flush();
  };

  return {
    push(event) {
      const merged = coalesce(queue.at(-1), event);
      if (merged) queue[queue.length - 1] = merged;
      else queue.push(event);
      if (isDeltaEvent(event)) {
        if (handle === null) handle = schedule(onTick);
      } else {
        flush();
      }
    },
    flush,
    dispose: flush,
  };
}
