/**
 * Zero-dependency test runner: compiled with tsc, executed with plain node.
 * Exits non-zero (uncaught throw) when any check fails.
 */

import type { AssistantTurnItem, TranscriptEvent, TranscriptState } from '../src/index.js';
import {
  applyTranscriptEvent,
  appendUserMessage,
  assertTranscriptEvent,
  initialTranscriptState,
  activeTurn,
  orderedToolCalls,
  pendingInteraction,
  turnText,
  turnThinking,
  mergeStreamText,
  splitThinkTags,
  stabilizeStreamingMarkdown,
} from '../src/index.js';

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${(error as Error).message}`);
  }
}

function eq(actual: unknown, expected: unknown, label = 'value'): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

function run(events: TranscriptEvent[], from = initialTranscriptState): TranscriptState {
  return events.reduce(
    (state, event) => applyTranscriptEvent(state, event, { assertEvents: true }),
    from,
  );
}

function onlyTurn(state: TranscriptState, id: string): AssistantTurnItem {
  const turn = state.items.find(
    item => item.kind === 'assistant_turn' && item.id === id,
  );
  if (!turn) throw new Error(`turn ${id} not found`);
  return turn as AssistantTurnItem;
}

// --- hermes-style flow: deltas + interleaved terminal tool ------------------

check('hermes flow: text → tool → text interleaving', () => {
  const state = run([
    { type: 'turn_started', turnId: 'r1', at: 1 },
    { type: 'text_delta', turnId: 'r1', delta: 'Running the tests' },
    { type: 'text_delta', turnId: 'r1', delta: ' now.' },
    { type: 'tool_started', turnId: 'r1', toolCallId: 't1', name: 'terminal', input: { command: 'npm test' } },
    { type: 'tool_activity', turnId: 'r1', toolCallId: 't1', outputDelta: '1 passing\n' },
    { type: 'tool_activity', turnId: 'r1', toolCallId: 't1', outputDelta: '1 failing\n', summary: 'npm test' },
    {
      type: 'tool_finished', turnId: 'r1', toolCallId: 't1',
      presentation: { kind: 'terminal', command: 'npm test', output: '1 passing\n1 failing' },
    },
    { type: 'text_delta', turnId: 'r1', delta: 'One test fails.' },
    { type: 'turn_finished', turnId: 'r1', usage: { outputTokens: 42 }, at: 9 },
  ]);
  const turn = onlyTurn(state, 'r1');
  eq(turn.blocks.map(b => b.kind), ['text', 'tool_call', 'text'], 'block order');
  eq(turnText(turn), 'Running the tests now.One test fails.', 'turnText');
  const tool = turn.toolCalls['t1'];
  eq(tool.status, 'success', 'tool status');
  eq(tool.activityLog, '1 passing\n1 failing\n', 'activityLog');
  eq(tool.summary, 'npm test', 'summary');
  eq(turn.status, 'complete', 'turn status');
  eq(turn.usage?.outputTokens, 42, 'usage');
  eq(orderedToolCalls(turn).map(t => t.id), ['t1'], 'orderedToolCalls');
});

// --- intellij-style: legacy snapshot after deltas, replay-safe --------------

check('intellij flow: snapshot merge and replay idempotence', () => {
  const events: TranscriptEvent[] = [
    { type: 'turn_started', turnId: 'r2' },
    { type: 'text_delta', turnId: 'r2', delta: 'Let me check' },
    { type: 'text_delta', turnId: 'r2', snapshot: 'Let me check the build file.' },
  ];
  const state = run(events);
  eq(turnText(onlyTurn(state, 'r2')), 'Let me check the build file.', 'snapshot extends');
  // replaying the same snapshot (reconnect) changes nothing
  const replayed = run([{ type: 'text_delta', turnId: 'r2', snapshot: 'Let me check the build file.' }], state);
  eq(turnText(onlyTurn(replayed, 'r2')), 'Let me check the build file.', 'replay no-op');
  // duplicate turn_started / tool_started are no-ops
  const dup = run([
    { type: 'turn_started', turnId: 'r2' },
    { type: 'tool_started', turnId: 'r2', toolCallId: 'x', name: 'Edit' },
    { type: 'tool_started', turnId: 'r2', toolCallId: 'x', name: 'Edit' },
  ], replayed);
  eq(onlyTurn(dup, 'r2').blocks.filter(b => b.kind === 'tool_call').length, 1, 'dup tool_started');
});

check('thinking blocks carry signature and split from text', () => {
  const state = run([
    { type: 'turn_started', turnId: 'r3' },
    { type: 'thinking_delta', turnId: 'r3', delta: 'hmm, ' },
    { type: 'thinking_delta', turnId: 'r3', delta: 'the fixture path', signature: 'sig1' },
    { type: 'text_delta', turnId: 'r3', delta: 'Found it.' },
  ]);
  const turn = onlyTurn(state, 'r3');
  eq(turn.blocks.map(b => b.kind), ['thinking', 'text'], 'block kinds');
  eq(turnThinking(turn), 'hmm, the fixture path', 'turnThinking');
  const thinking = turn.blocks[0];
  if (thinking.kind !== 'thinking') throw new Error('expected thinking block');
  eq(thinking.signature, 'sig1', 'signature');
  eq(activeTurn(state)?.id, 'r3', 'activeTurn');
});

// --- decision #1: todos latest-wins ----------------------------------------

check('todos: latest-wins across tool presentation and marker', () => {
  const state = run([
    { type: 'turn_started', turnId: 'r4' },
    {
      type: 'tool_finished', turnId: 'r4', toolCallId: 'todo1',
      presentation: { kind: 'todo', todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] },
    },
    {
      type: 'marker', markerId: 'm1', markerType: 'todo_update',
      payload: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] },
    },
  ]);
  eq(state.todos, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
  ], 'latest wins');
  // create-if-missing on tool_finished still records the timeline entry
  eq(onlyTurn(state, 'r4').toolCalls['todo1'].status, 'success', 'created tool');
  // duplicate marker is a no-op
  const dup = run([{ type: 'marker', markerId: 'm1', markerType: 'todo_update', payload: [] }], state);
  eq(dup.todos.length, 2, 'dup marker ignored');
});

// --- interactions: pending queue, turn-end cleanup, tool cancellation -------

check('interactions: queue, resolve, and turn-failure cleanup', () => {
  let state = run([
    { type: 'turn_started', turnId: 'r5' },
    { type: 'tool_started', turnId: 'r5', toolCallId: 'long', name: 'Bash' },
    {
      type: 'interaction_requested',
      request: { kind: 'approval', id: 'i1', turnId: 'r5', command: 'rm -rf build', allowedScopes: ['once', 'session'] },
    },
    {
      type: 'interaction_requested',
      request: { kind: 'secret_input', id: 'i2', secretKind: 'password' },
    },
  ]);
  eq(pendingInteraction(state)?.id, 'i1', 'oldest first');
  state = run([{ type: 'interaction_resolved', interactionId: 'i1', reason: 'answered' }], state);
  eq(pendingInteraction(state)?.id, 'i2', 'next after resolve');
  state = run([{ type: 'turn_failed', turnId: 'r5', error: 'provider crashed' }], state);
  const turn = onlyTurn(state, 'r5');
  eq(turn.status, 'failed', 'failed status');
  eq(turn.toolCalls['long'].status, 'cancelled', 'running tool cancelled');
  // i2 has no turnId — survives turn end; turn-scoped ones would be dropped
  eq(pendingInteraction(state)?.id, 'i2', 'unscoped interaction survives');
});

// --- user messages + implicit turn upsert ----------------------------------

check('user message append and mid-stream reconnect upsert', () => {
  let state = appendUserMessage(initialTranscriptState, {
    kind: 'user_message', id: 'u1', text: 'hi',
  });
  // delta arrives with no prior turn_started (reconnect mid-stream)
  state = run([{ type: 'text_delta', turnId: 'r6', delta: 'hello' }], state);
  eq(state.items.map(i => i.kind), ['user_message', 'assistant_turn'], 'order');
  eq(turnText(onlyTurn(state, 'r6')), 'hello', 'implicit upsert');
});

// --- text utils -------------------------------------------------------------

check('mergeStreamText semantics', () => {
  eq(mergeStreamText('ab', 'c', false), 'abc', 'append');
  eq(mergeStreamText('ab', 'abcd', true), 'abcd', 'snapshot extends');
  eq(mergeStreamText('abcd', 'cd', true), 'abcd', 'suffix replay ignored');
  eq(mergeStreamText('ab', 'xy', true), 'abxy', 'unrelated appends');
  eq(mergeStreamText('ab', '', true), 'ab', 'empty ignored');
});

check('splitThinkTags: closed, unclosed, mixed', () => {
  eq(splitThinkTags('a<think>t1</think>b'), { visible: 'ab', thinking: 't1', thinkingOpen: false }, 'closed');
  eq(splitThinkTags('a<thinking>still going'), { visible: 'a', thinking: 'still going', thinkingOpen: true }, 'unclosed');
  eq(
    splitThinkTags('<think>x</think>mid<think>y</think>end'),
    { visible: 'midend', thinking: 'xy', thinkingOpen: false },
    'multiple segments',
  );
  eq(splitThinkTags('no tags'), { visible: 'no tags', thinking: '', thinkingOpen: false }, 'none');
});

check('stabilizeStreamingMarkdown closes dangling fences', () => {
  eq(stabilizeStreamingMarkdown('a\n```js\ncode'), 'a\n```js\ncode\n```', 'dangling closed');
  eq(stabilizeStreamingMarkdown('a\n```js\ncode\n```\nb'), 'a\n```js\ncode\n```\nb', 'balanced untouched');
  eq(stabilizeStreamingMarkdown('~~~~\ncode'), '~~~~\ncode\n~~~~', 'tilde fence length kept');
  eq(stabilizeStreamingMarkdown('plain'), 'plain', 'no fences');
});

// --- guards -----------------------------------------------------------------

check('assertTranscriptEvent rejects malformed events', () => {
  const bad: unknown[] = [
    null,
    { type: 'nope' },
    { type: 'text_delta', turnId: 'x' }, // neither delta nor snapshot
    { type: 'tool_started', turnId: 'x', toolCallId: 't' }, // missing name
    { type: 'turn_failed', turnId: 'x' }, // missing error
    { type: 'interaction_requested', request: { id: 'i', kind: 'bogus' } },
    { type: 'interaction_resolved', interactionId: 'i', reason: 'whatever' },
    { type: 'marker', markerId: 'm' }, // missing markerType
  ];
  for (const event of bad) {
    let threw = false;
    try {
      assertTranscriptEvent(event);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`expected throw for ${JSON.stringify(event)}`);
  }
});

if (failures > 0) {
  throw new Error(`${failures} check(s) failed`);
}
console.log('\nall checks passed');
