/**
 * Dev-only event validation (decision #5).
 *
 * The kit ↔ adapter boundary is compile-time typed, so the runtime risk this
 * guards against is adapter bugs: wire payloads cast with `as` and fed
 * through with wrong shapes. Hosts enable it in dev builds via
 * `applyTranscriptEvent(state, event, { assertEvents: import.meta.env.DEV })`
 * (or equivalent); production skips it entirely. No zod — hand-written, zero
 * dependencies.
 */

import type { TranscriptEvent } from './events.js';

const INTERACTION_KINDS = new Set([
  'approval',
  'question',
  'form',
  'plan_review',
  'secret_input',
]);

const RESOLVED_REASONS = new Set([
  'answered',
  'timeout',
  'cancelled',
  'superseded',
  'stale',
]);

function fail(message: string, value: unknown): never {
  let dump: string;
  try {
    dump = JSON.stringify(value)?.slice(0, 400) ?? String(value);
  } catch {
    dump = String(value);
  }
  throw new TypeError(
    `[transcript-kit] invalid TranscriptEvent: ${message}\nevent: ${dump}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  event: Record<string, unknown>,
  field: string,
): void {
  if (typeof event[field] !== 'string' || event[field] === '') {
    fail(`"${field}" must be a non-empty string`, event);
  }
}

function optionalString(
  event: Record<string, unknown>,
  field: string,
): void {
  if (event[field] !== undefined && typeof event[field] !== 'string') {
    fail(`"${field}" must be a string when present`, event);
  }
}

/** Throws TypeError with a readable message when the event is malformed. */
export function assertTranscriptEvent(
  value: unknown,
): asserts value is TranscriptEvent {
  if (!isRecord(value)) fail('event must be an object', value);
  const event = value;

  switch (event.type) {
    case 'turn_started':
    case 'turn_finished':
    case 'turn_cancelled':
      requireString(event, 'turnId');
      return;
    case 'turn_failed':
      requireString(event, 'turnId');
      requireString(event, 'error');
      return;
    case 'text_delta':
    case 'thinking_delta':
      requireString(event, 'turnId');
      optionalString(event, 'delta');
      optionalString(event, 'snapshot');
      if (event.delta === undefined && event.snapshot === undefined) {
        fail('needs "delta" or "snapshot"', event);
      }
      return;
    case 'tool_started':
      requireString(event, 'turnId');
      requireString(event, 'toolCallId');
      requireString(event, 'name');
      return;
    case 'tool_activity':
      requireString(event, 'turnId');
      requireString(event, 'toolCallId');
      optionalString(event, 'summary');
      optionalString(event, 'outputDelta');
      return;
    case 'tool_finished':
      requireString(event, 'turnId');
      requireString(event, 'toolCallId');
      if (event.presentation !== undefined) {
        if (
          !isRecord(event.presentation) ||
          typeof event.presentation.kind !== 'string'
        ) {
          fail('"presentation" must be an object with a string "kind"', event);
        }
      }
      return;
    case 'interaction_requested': {
      if (!isRecord(event.request)) fail('"request" must be an object', event);
      const request = event.request;
      if (typeof request.id !== 'string' || request.id === '') {
        fail('"request.id" must be a non-empty string', event);
      }
      if (
        typeof request.kind !== 'string' ||
        !INTERACTION_KINDS.has(request.kind)
      ) {
        fail(
          `"request.kind" must be one of ${[...INTERACTION_KINDS].join(', ')}`,
          event,
        );
      }
      return;
    }
    case 'interaction_resolved':
      requireString(event, 'interactionId');
      if (
        typeof event.reason !== 'string' ||
        !RESOLVED_REASONS.has(event.reason)
      ) {
        fail(
          `"reason" must be one of ${[...RESOLVED_REASONS].join(', ')}`,
          event,
        );
      }
      return;
    case 'marker':
      requireString(event, 'markerId');
      requireString(event, 'markerType');
      return;
    default:
      fail(`unknown event type "${String(event.type)}"`, event);
  }
}
