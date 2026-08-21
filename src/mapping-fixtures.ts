/**
 * Compile-time mapping validation: one representative scenario per host,
 * hand-translated from its current model into the shared types. Never
 * shipped — exists so `tsc --strict` proves the mappings in docs/mapping.md
 * actually type-check.
 */

import type { AssistantTurnItem, MarkerItem, TranscriptItem } from './transcript.js';
import type { InteractionRequest, InteractionResponse } from './interaction.js';
import type { TranscriptEvent } from './events.js';

// --- hermes: terminal tool + search tool in one turn, clarify prompt --------

const hermesTurn: AssistantTurnItem = {
  kind: 'assistant_turn',
  id: 'run-42',
  status: 'complete',
  blocks: [
    { kind: 'thinking', text: 'user wants the failing test' },
    { kind: 'tool_call', toolCallId: 't1' },
    { kind: 'tool_call', toolCallId: 't2' },
    { kind: 'text', text: 'Found it — the fixture path is stale.' },
  ],
  toolCalls: {
    t1: {
      id: 't1',
      name: 'terminal',
      status: 'success',
      summary: 'npm test',
      startedAt: 1_755_700_000_000,
      completedAt: 1_755_700_012_000, // ChatEntry.toolDurationSeconds => timestamps
      presentation: { kind: 'terminal', command: 'npm test', output: '1 failing' },
    },
    t2: {
      id: 't2',
      name: 'web_search',
      status: 'success',
      presentation: {
        kind: 'search',
        query: 'vitest fixture ENOENT',
        results: [{ title: 'Vitest issue #1', url: 'https://example.com', snippet: '...' }],
      },
    },
  },
  ext: { rowId: 913, reactions: [{ author: 'user', emoji: '👍' }] },
};

const hermesClarify: InteractionRequest = {
  kind: 'question',
  id: 'req-7',
  questions: [
    {
      question: 'Which environment?',
      options: [
        { value: 'staging', label: 'staging' },
        { value: 'prod', label: 'prod' },
      ],
      allowCustomValue: false,
    },
  ],
};

const hermesApprovalAnswer: InteractionResponse = {
  kind: 'approval',
  decision: 'allow',
  scope: 'session', // maps back to choice: 'session'
};

// --- intellij: legacy snapshot delta + elicitation form ---------------------

const intellijEvents: TranscriptEvent[] = [
  { type: 'turn_started', turnId: 'run-9' },
  { type: 'text_delta', turnId: 'run-9', delta: 'Let me check' },
  // legacy provider final snapshot (mergeAssistantContent case)
  { type: 'text_delta', turnId: 'run-9', snapshot: 'Let me check the build file.' },
  {
    type: 'tool_started',
    turnId: 'run-9',
    toolCallId: 'tu-1',
    name: 'ExitPlanMode',
    semantic: 'plan_exit',
  },
  { type: 'marker', markerId: 'm1', markerType: 'mode_transition', payload: { mode: 'default' } },
  { type: 'turn_finished', turnId: 'run-9', usage: { outputTokens: 812 } },
];

const intellijElicitation: InteractionRequest = {
  kind: 'form',
  id: 'int-3',
  title: 'Configure connection',
  fields: [
    { id: 'host', label: 'Host', type: 'text', required: true },
    { id: 'tls', label: 'Use TLS', type: 'confirm', defaultValue: 'true' },
  ],
};

// --- zclaudia: interleaved blocks, compaction marker, plan review -----------

const zclaudiaItems: TranscriptItem[] = [
  {
    kind: 'user_message',
    id: 'm-1',
    text: 'refactor the store',
    attachments: [{ ref: 'file-abc', name: 'store.ts', mimeType: 'text/plain', type: 'file' }],
    steered: false,
  },
  {
    kind: 'assistant_turn',
    id: 'm-2',
    status: 'streaming',
    blocks: [
      { kind: 'text', text: 'Starting with the selectors.' },
      { kind: 'tool_call', toolCallId: 'tu-9' },
    ],
    toolCalls: {
      'tu-9': {
        id: 'tu-9',
        name: 'Edit',
        status: 'running',
        semantic: undefined,
        presentation: { kind: 'file_edit', filePath: 'src/store.ts', changeKind: 'modify' },
      },
    },
    usage: { totalTokens: 4200, costUsd: 0.03, contextUsedTokens: 61_000 },
  },
  {
    kind: 'marker',
    id: 'cmp-1',
    markerType: 'compaction',
    payload: { summary: 'Compacted 120k → 8k', source: 'auto' },
  } satisfies MarkerItem,
];

const zclaudiaPlanReview: InteractionRequest = {
  kind: 'plan_review',
  id: 'int-11',
  plan: '## Plan\n1. props-ize stores',
  todos: [{ content: 'props-ize MessageList', status: 'pending' }],
  ext: { allowedPrompts: [{ tool: 'Bash', prompt: 'pnpm test' }] },
};

export const fixtures = {
  hermesTurn,
  hermesClarify,
  hermesApprovalAnswer,
  intellijEvents,
  intellijElicitation,
  zclaudiaItems,
  zclaudiaPlanReview,
};
