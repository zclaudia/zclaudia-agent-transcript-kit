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
  stripAnsi,
  createTranscriptBatcher,
  classifyTool,
  toolSummary,
  toolDisplayName,
  isTodoTool,
  isAskUserFormTool,
  isApprovalTool,
  isAskUserQuestionTool,
  isPushFileTool,
  isPlanModeTool,
  isPlanProposalTool,
  isInteractionTool,
  normalizeToolInput,
  extractFilePath,
  normalizeTodoItems,
  diffLines,
  parseUnifiedDiff,
  diffStats,
  extractUnifiedDiffPath,
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
  eq(
    splitThinkTags('a<think>t1</think>b'),
    { visible: 'ab', thinking: 't1', thinkingSegments: ['t1'], thinkingOpen: false },
    'closed',
  );
  eq(
    splitThinkTags('a<thinking>still going'),
    { visible: 'a', thinking: 'still going', thinkingSegments: ['still going'], thinkingOpen: true },
    'unclosed',
  );
  eq(
    splitThinkTags('<think>x</think>mid<think>y</think>end'),
    { visible: 'midend', thinking: 'xy', thinkingSegments: ['x', 'y'], thinkingOpen: false },
    'multiple segments keep boundaries',
  );
  eq(
    splitThinkTags('no tags'),
    { visible: 'no tags', thinking: '', thinkingSegments: [], thinkingOpen: false },
    'none',
  );
});

check('stabilizeStreamingMarkdown closes dangling fences', () => {
  eq(stabilizeStreamingMarkdown('a\n```js\ncode'), 'a\n```js\ncode\n```', 'dangling closed');
  eq(stabilizeStreamingMarkdown('a\n```js\ncode\n```\nb'), 'a\n```js\ncode\n```\nb', 'balanced untouched');
  eq(stabilizeStreamingMarkdown('~~~~\ncode'), '~~~~\ncode\n~~~~', 'tilde fence length kept');
  eq(stabilizeStreamingMarkdown('plain'), 'plain', 'no fences');
});

// --- delta batching ----------------------------------------------------------

interface ManualScheduler {
  ticks: Array<() => void>;
  cancelled: number;
  schedule: (cb: () => void) => unknown;
  cancel: (handle: unknown) => void;
  fire: () => void;
}

function manualScheduler(): ManualScheduler {
  const scheduler: ManualScheduler = {
    ticks: [],
    cancelled: 0,
    schedule: cb => {
      scheduler.ticks.push(cb);
      return scheduler.ticks.length - 1;
    },
    cancel: () => {
      scheduler.cancelled += 1;
    },
    fire: () => {
      const pending = scheduler.ticks.splice(0);
      for (const tick of pending) tick();
    },
  };
  return scheduler;
}

check('batcher: coalesces same-turn deltas into one flush', () => {
  const flushed: TranscriptEvent[][] = [];
  const scheduler = manualScheduler();
  const batcher = createTranscriptBatcher({
    onFlush: events => flushed.push(events),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  batcher.push({ type: 'text_delta', turnId: 'r1', delta: 'a' });
  batcher.push({ type: 'text_delta', turnId: 'r1', delta: 'b' });
  batcher.push({ type: 'thinking_delta', turnId: 'r1', delta: 'x' });
  batcher.push({ type: 'thinking_delta', turnId: 'r1', delta: 'y' });
  eq(flushed.length, 0, 'nothing before tick');
  eq(scheduler.ticks.length, 1, 'single scheduled tick');
  scheduler.fire();
  eq(flushed, [[
    { type: 'text_delta', turnId: 'r1', delta: 'ab' },
    { type: 'thinking_delta', turnId: 'r1', delta: 'xy' },
  ]], 'coalesced in order');
  scheduler.fire();
  eq(flushed.length, 1, 'no empty re-flush');
});

check('batcher: snapshots and other turns are not merged', () => {
  const flushed: TranscriptEvent[][] = [];
  const scheduler = manualScheduler();
  const batcher = createTranscriptBatcher({
    onFlush: events => flushed.push(events),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  batcher.push({ type: 'text_delta', turnId: 'r1', delta: 'a' });
  batcher.push({ type: 'text_delta', turnId: 'r2', delta: 'b' });
  batcher.push({ type: 'text_delta', turnId: 'r2', snapshot: 'full' });
  scheduler.fire();
  eq(flushed, [[
    { type: 'text_delta', turnId: 'r1', delta: 'a' },
    { type: 'text_delta', turnId: 'r2', delta: 'b' },
    { type: 'text_delta', turnId: 'r2', snapshot: 'full' },
  ]], 'kept separate');
});

check('batcher: tool_activity merges output, summary latest-wins', () => {
  const flushed: TranscriptEvent[][] = [];
  const scheduler = manualScheduler();
  const batcher = createTranscriptBatcher({
    onFlush: events => flushed.push(events),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  batcher.push({ type: 'tool_activity', turnId: 'r1', toolCallId: 't1', outputDelta: '1\n' });
  batcher.push({ type: 'tool_activity', turnId: 'r1', toolCallId: 't1', outputDelta: '2\n', summary: 'running' });
  batcher.push({ type: 'tool_activity', turnId: 'r1', toolCallId: 't2', outputDelta: 'other' });
  scheduler.fire();
  eq(flushed, [[
    { type: 'tool_activity', turnId: 'r1', toolCallId: 't1', outputDelta: '1\n2\n', summary: 'running' },
    { type: 'tool_activity', turnId: 'r1', toolCallId: 't2', outputDelta: 'other' },
  ]], 'merged per tool');
});

check('batcher: lifecycle events flush synchronously in order', () => {
  const flushed: TranscriptEvent[][] = [];
  const scheduler = manualScheduler();
  const batcher = createTranscriptBatcher({
    onFlush: events => flushed.push(events),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  batcher.push({ type: 'text_delta', turnId: 'r1', delta: 'done' });
  batcher.push({ type: 'turn_finished', turnId: 'r1' });
  eq(flushed, [[
    { type: 'text_delta', turnId: 'r1', delta: 'done' },
    { type: 'turn_finished', turnId: 'r1' },
  ]], 'urgent event carries pending deltas');
  scheduler.fire();
  eq(flushed.length, 1, 'stale tick is a no-op');
});

check('batcher: manual flush and dispose', () => {
  const flushed: TranscriptEvent[][] = [];
  const scheduler = manualScheduler();
  const batcher = createTranscriptBatcher({
    onFlush: events => flushed.push(events),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  batcher.push({ type: 'text_delta', turnId: 'r1', delta: 'a' });
  batcher.flush();
  eq(flushed, [[{ type: 'text_delta', turnId: 'r1', delta: 'a' }]], 'manual flush');
  eq(scheduler.cancelled, 1, 'scheduled tick cancelled');
  batcher.push({ type: 'text_delta', turnId: 'r1', delta: 'b' });
  batcher.dispose();
  eq(flushed.length, 2, 'dispose flushes remainder');
  eq(flushed[1], [{ type: 'text_delta', turnId: 'r1', delta: 'b' }], 'disposed content');
});

// --- tool classifier ---------------------------------------------------------

check('classifyTool: terminal across host tool names', () => {
  eq(
    classifyTool({ name: 'Bash', input: { command: 'ls -la' }, result: 'total 8\n' }),
    { kind: 'terminal', command: 'ls -la', output: 'total 8' },
    'claude-style Bash with string result',
  );
  eq(
    classifyTool({
      name: 'terminal',
      input: { context: 'pwd' },
      result: { output: '/home' },
    }),
    { kind: 'terminal', command: 'pwd', output: '/home' },
    'hermes terminal with context key',
  );
  eq(
    classifyTool({
      name: 'execute_code',
      input: { code: 'print(1)' },
      result: { lines: ['1', '2'] },
    }),
    { kind: 'terminal', command: 'print(1)', output: '1\n2' },
    'lines array joined',
  );
});

check('classifyTool: file edits carry path and diff', () => {
  eq(
    classifyTool({ name: 'Edit', input: { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' } }),
    { kind: 'file_edit', filePath: '/a/b.ts' },
    'claude Edit',
  );
  eq(
    classifyTool({
      name: 'edit_file',
      input: { path: 'src/x.py' },
      result: { inline_diff: '-a\n+b' },
    }),
    { kind: 'file_edit', filePath: 'src/x.py', diff: '-a\n+b' },
    'hermes edit_file with inline diff',
  );
});

check('classifyTool: search variants normalize query and results', () => {
  eq(
    classifyTool({ name: 'Grep', input: { pattern: 'TODO', path: 'src' } }),
    { kind: 'search', query: 'TODO in src', results: [] },
    'grep',
  );
  eq(
    classifyTool({
      name: 'web_search',
      input: { search_term: 'zig build' },
      result: { results: [{ title: 'Zig', url: 'https://z.org', snippet: 's' }, { name: 'no url' }] },
    }),
    {
      kind: 'search',
      query: 'zig build',
      results: [{ title: 'Zig', url: 'https://z.org', snippet: 's' }],
    },
    'web_search maps and filters results',
  );
});

check('classifyTool: image, todo, and generic fallback', () => {
  eq(
    classifyTool({ name: 'image_generate', result: { image: 'data:image/png;base64,x' } }),
    { kind: 'image', url: 'data:image/png;base64,x' },
    'image data uri',
  );
  eq(
    classifyTool({
      name: 'TodoWrite',
      input: { todos: [{ content: 'a', status: 'in_progress' }, { content: '', status: 'x' }] },
    }),
    { kind: 'todo', todos: [{ content: 'a', status: 'in_progress' }] },
    'todos normalized, empty dropped',
  );
  eq(
    classifyTool({ name: 'mystery', result: { anything: 1 } }),
    { kind: 'generic', text: '{\n  "anything": 1\n}' },
    'generic printable result',
  );
});

check('tool input helpers: normalize, path keys, todo names', () => {
  eq(normalizeToolInput('{"a":1}'), { a: 1 }, 'stringified json parsed');
  eq(normalizeToolInput('not json'), 'not json', 'plain string kept');
  eq(extractFilePath({ notebook_path: '/n.ipynb' }), '/n.ipynb', 'notebook_path');
  eq(extractFilePath({ x: 1 }), undefined, 'no path key');
  eq(isTodoTool('TodoWrite'), true, 'TodoWrite');
  eq(isTodoTool('mcp__x__update_todo_list'), true, 'mcp suffix');
  eq(isTodoTool('Read'), false, 'not todo');
  eq(
    normalizeTodoItems({ items: [{ content: 'a', status: 'completed' }] }),
    [{ content: 'a', status: 'completed' }],
    'nested items key',
  );
});

check('toolSummary: one-line header per tool family', () => {
  eq(toolSummary('Bash', { command: 'npm test' }), 'npm test', 'bash command');
  eq(toolSummary('Edit', { file_path: '/a/b.ts' }), '/a/b.ts', 'edit path');
  eq(toolSummary('Grep', { pattern: 'x', path: 'src' }), 'x in src', 'grep');
  eq(toolSummary('TodoWrite', { todos: [] }), 'Update task list', 'todo');
  eq(toolSummary('WebFetch', { url: 'https://a.io' }), 'https://a.io', 'webfetch');
  eq(toolSummary('mystery', { a: 1 }), '{"a":1}', 'compact json fallback');
  eq(toolSummary('mystery', 'nope'), '', 'non-object input');
});

check('tool_started fills in arguments that stream in after the name', () => {
  // Providers announce a tool before its arguments finish generating, so a
  // second tool_started for the same call carries the input the first lacked.
  // Filling in only what is missing keeps replay a strict no-op.
  const state = run([
    { type: 'turn_started', turnId: 'r-gen' },
    { type: 'tool_started', turnId: 'r-gen', toolCallId: 't1', name: 'terminal' },
    { type: 'tool_started', turnId: 'r-gen', toolCallId: 't1', name: 'terminal', input: { command: 'ls' } },
  ]);
  const turn = onlyTurn(state, 'r-gen');
  eq(turn.blocks.filter(b => b.kind === 'tool_call').length, 1, 'still one block');
  eq(turn.toolCalls['t1'].input, { command: 'ls' }, 'input filled in');

  // Replaying an identical event stays a no-op, so reconnect replay cannot
  // churn state or identity.
  const replayed = run(
    [{ type: 'tool_started', turnId: 'r-gen', toolCallId: 't1', name: 'terminal', input: { command: 'ls' } }],
    state,
  );
  if (replayed !== state) throw new Error('identical replay should not change state');

  // A later event that omits the name must not blank the one already known.
  const unnamed = run(
    [{ type: 'tool_started', turnId: 'r-gen', toolCallId: 't1' }],
    state,
  );
  eq(onlyTurn(unnamed, 'r-gen').toolCalls['t1'].name, 'terminal', 'name preserved');
});

// --- agent-ecosystem tool conventions ------------------------------------

check('interaction tool predicates match MCP naming and plan semantics', () => {
  // Bridged MCP tools arrive namespaced; the bare name is the contract.
  for (const name of ['ask_user_form', 'mcp__x__ask_user_form', 'server-ask_user_form']) {
    eq(isAskUserFormTool(name), true, `form: ${name}`);
  }
  eq(isAskUserFormTool('ask_user_form_extra'), false, 'suffix must terminate');
  eq(isApprovalTool('mcp__x__request_approval'), true, 'approval');
  eq(isPushFileTool('mcp__x__push_file'), true, 'push file');
  eq(isAskUserQuestionTool('AskUserQuestion'), true, 'question');

  // The provider's semantic outranks names; name matching is the fallback for
  // bridges that do not send one yet.
  eq(isPlanModeTool('whatever', 'plan_enter'), true, 'semantic enter');
  eq(isPlanModeTool('ExitPlanMode'), true, 'native name');
  eq(isPlanModeTool('mcp__x__enter_plan_mode'), true, 'bridge name');
  eq(isPlanProposalTool('whatever', 'plan_proposal'), true, 'semantic proposal');
  eq(isPlanProposalTool('EnterPlanMode'), false, 'entering is not proposing');
  eq(isInteractionTool('TodoWrite'), true, 'todo is an interaction tool');
  eq(isInteractionTool('Bash'), false, 'plain tool');
});

check('toolDisplayName normalizes bridged names to their short form', () => {
  eq(toolDisplayName('mcp__x__update_todo_list'), 'TodoWrite', 'todo');
  eq(toolDisplayName('mcp__x__ask_user_form'), 'AskUserForm', 'form');
  eq(toolDisplayName('mcp__x__request_approval'), 'RequestApproval', 'approval');
  eq(toolDisplayName('mcp__x__push_file'), 'PushFile', 'push file');
  eq(toolDisplayName('ExitPlanMode'), 'Plan proposal', 'plan by name');
  eq(toolDisplayName('whatever', 'plan_proposal'), 'Plan proposal', 'plan by semantic');
  eq(toolDisplayName('Bash'), 'Bash', 'unknown passes through');
});

check('toolSummary covers interaction and plan tools', () => {
  eq(toolSummary('mcp__x__ask_user_form', { title: 'Pick one' }), 'Pick one', 'form title');
  eq(toolSummary('mcp__x__ask_user_form', {}), 'Form', 'form fallback');
  eq(toolSummary('mcp__x__request_approval', {}), 'Approval required', 'approval fallback');
  eq(toolSummary('mcp__x__push_file', { filePath: '/a/b/c.ts' }), 'c.ts', 'push file basename');
  eq(toolSummary('X', {}, 'plan_enter'), 'Entering plan mode', 'plan enter');
  eq(toolSummary('X', {}, 'plan_exit'), 'Exiting plan mode', 'plan exit');
  // A proposal summarizes to the plan's first meaningful line, heading marker
  // stripped, so the collapsed card says what the plan is about.
  eq(
    toolSummary('ExitPlanMode', { plan: '# Refactor the parser\nstep 1' }, 'plan_proposal'),
    'Refactor the parser',
    'plan first line',
  );
  eq(toolSummary('ExitPlanMode', {}, 'plan_proposal'), 'Plan ready for review', 'plan fallback');
  eq(
    toolSummary('MultiEdit', { file_path: '/a.ts', edits: [1, 2, 3] }),
    '/a.ts | 3 edits',
    'multiedit count',
  );
  eq(toolSummary('ReadSymbol', { path: '/a.ts', symbol: 'foo' }), '/a.ts#foo', 'symbol');
  eq(
    toolSummary('AskUserQuestion', { questions: [{ question: 'a' }, { question: 'b' }] }),
    '2 questions',
    'question count',
  );
  eq(toolSummary('AskUserQuestion', { questions: [{ question: 'a' }] }), '1 question', 'singular');
});

// --- diff utilities ---------------------------------------------------------

check('diffLines: LCS keeps context, marks changes', () => {
  eq(
    diffLines('a\nb\nc', 'a\nx\nc'),
    [
      { kind: 'context', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'context', text: 'c' },
    ],
    'replace middle line',
  );
  eq(
    diffLines('', 'a'),
    [{ kind: 'removed', text: '' }, { kind: 'added', text: 'a' }],
    'empty old side',
  );
  eq(diffLines('same', 'same'), [{ kind: 'context', text: 'same' }], 'identical');
});

check('diffLines: empty sides still occupy a row', () => {
  // '' splits into [''], so an empty file is one empty line, not zero lines —
  // a pure insertion therefore drops that empty line and adds the new ones.
  eq(diffLines('', ''), [{ kind: 'context', text: '' }], 'both empty');
  eq(
    diffLines('', 'line1\nline2'),
    [
      { kind: 'removed', text: '' },
      { kind: 'added', text: 'line1' },
      { kind: 'added', text: 'line2' },
    ],
    'pure insertion',
  );
  eq(
    diffLines('line1\nline2', ''),
    [
      { kind: 'removed', text: 'line1' },
      { kind: 'removed', text: 'line2' },
      { kind: 'added', text: '' },
    ],
    'pure deletion',
  );
});

check('diffLines: a change lands where it happened, not at the edges', () => {
  eq(
    diffLines('a\nb\nc', 'a\ninserted\nb\nc'),
    [
      { kind: 'context', text: 'a' },
      { kind: 'added', text: 'inserted' },
      { kind: 'context', text: 'b' },
      { kind: 'context', text: 'c' },
    ],
    'insertion in the middle',
  );
  eq(
    diffLines('a\nb\nremove\nc', 'a\nb\nc'),
    [
      { kind: 'context', text: 'a' },
      { kind: 'context', text: 'b' },
      { kind: 'removed', text: 'remove' },
      { kind: 'context', text: 'c' },
    ],
    'deletion from the middle',
  );
});

check('diffLines: over the cap degrades to removed/added runs', () => {
  const oldText = Array.from({ length: 401 }, (_, i) => `line${i}`).join('\n');
  const lines = diffLines(oldText, 'new');
  eq(lines.length, 402, 'all lines present');
  eq(lines[0], { kind: 'removed', text: 'line0' }, 'old side removed');
  eq(lines.at(-1), { kind: 'added', text: 'new' }, 'new side added');
  eq(lines.some(l => l.kind === 'context'), false, 'no context computed');
});

check('diffStats counts added and removed lines', () => {
  eq(diffStats(diffLines('a\nb', 'a\nc\nd')), { added: 2, removed: 1 }, 'stats');
});

check('parseUnifiedDiff classifies lines and strips ANSI', () => {
  const diff = [
    'diff --git a/src/x.ts b/src/x.ts',
    'index 123..456 100644',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -1,2 +1,2 @@',
    ' unchanged',
    '-\u001b[31mold\u001b[0m',
    '+new',
  ].join('\n');
  eq(
    parseUnifiedDiff(diff).map(l => l.kind),
    ['meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'removed', 'added'],
    'kinds',
  );
  eq(parseUnifiedDiff(diff)[6].text, '-old', 'ansi stripped');
  eq(extractUnifiedDiffPath(diff), 'src/x.ts', 'path from +++ header');
});

check('stripAnsi removes color and cursor sequences', () => {
  eq(stripAnsi('\u001b[31mred\u001b[0m plain\u001b[2K'), 'red plain', 'stripped');
  eq(stripAnsi('no escapes'), 'no escapes', 'untouched');
});

// --- guards -----------------------------------------------------------------

check('assertTranscriptEvent rejects malformed events', () => {
  const bad: unknown[] = [
    null,
    { type: 'nope' },
    { type: 'text_delta', turnId: 'x' }, // neither delta nor snapshot
    { type: 'tool_started', turnId: 'x', name: 'Edit' }, // missing toolCallId
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
