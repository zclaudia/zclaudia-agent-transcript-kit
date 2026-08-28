/**
 * Shared tool classifier: name + input + result → ToolPresentation, plus the
 * one-line summary helpers every host renders in a collapsed card header.
 *
 * This is a convenience for adapters — an adapter with better wire-level
 * knowledge (explicit tool kinds, pre-rendered diffs) should build the
 * presentation itself and skip this. Tool names cover both Claude-style
 * (Bash/Edit/Grep/TodoWrite) and pi-agent-style (terminal/edit_file/
 * web_search) vocabularies.
 *
 * Design inputs:
 *  - hermes    lib/stream-model.ts             (parseCompletedTool, result caps)
 *  - intellij  ui/transcript/tool-presentation.ts (summary/path helpers)
 *  - zclaudia  tool-call/toolClassifiers.ts + toolFormatters.ts (todo/MCP names)
 */

import type {
  SearchResultView,
  TodoItemView,
  ToolPresentation,
  ToolSemantic,
} from './transcript.js';

/** Some providers send stringified JSON instead of objects; normalize once. */
export function normalizeToolInput(input: unknown): unknown {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return input;
    }
  }
  return input;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  const normalized = normalizeToolInput(value);
  return typeof normalized === 'object' && normalized !== null && !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>)
    : undefined;
}

// Best-effort extraction of a file path from a tool call's (untyped) input,
// covering the common path-like keys across provider tool schemas.
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'notebook_path'] as const;

export function extractFilePath(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Agent tools reach a transcript under many names for the same job: a host's
 * built-in `TodoWrite`, or the same capability bridged over MCP as
 * `mcp__server__update_todo_list`. Bridges prefix and separate differently, so
 * matching is on the terminating bare name.
 */
function hasToolSuffix(name: string, suffix: string): boolean {
  return (
    name === suffix ||
    name.endsWith(`_${suffix}`) ||
    name.endsWith(`-${suffix}`) ||
    name.endsWith(`:${suffix}`)
  );
}

/** Todo-list tools: built-in TodoWrite plus MCP update_todo_list variants. */
export function isTodoTool(name: string): boolean {
  if (name === 'TodoWrite') return true;
  if (hasToolSuffix(name, 'update_todo_list')) return true;
  const normalized = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'updatetodos' || normalized === 'todolist' || normalized === 'todolistwrite';
}

export function isAskUserFormTool(name: string): boolean {
  return hasToolSuffix(name, 'ask_user_form');
}

export function isApprovalTool(name: string): boolean {
  return hasToolSuffix(name, 'request_approval');
}

export function isAskUserQuestionTool(name: string): boolean {
  return name === 'AskUserQuestion';
}

export function isPushFileTool(name: string): boolean {
  return hasToolSuffix(name, 'push_file');
}

/**
 * Whether a tool participates in plan-mode UX. The provider's declared
 * `semantic` is the source of truth; name matching is the fallback for bridges
 * that do not send one yet.
 */
export function isPlanModeTool(name: string, semantic?: ToolSemantic): boolean {
  if (semantic === 'plan_enter' || semantic === 'plan_exit' || semantic === 'plan_proposal') {
    return true;
  }
  if (name === 'EnterPlanMode' || name === 'ExitPlanMode') return true;
  return hasToolSuffix(name, 'enter_plan_mode') || hasToolSuffix(name, 'exit_plan_mode');
}

/** Whether a tool carries a plan proposal that should render as a plan card. */
export function isPlanProposalTool(name: string, semantic?: ToolSemantic): boolean {
  if (semantic === 'plan_proposal') return true;
  if (name === 'ExitPlanMode') return true;
  return hasToolSuffix(name, 'exit_plan_mode');
}

/** Any tool whose result is an interaction rather than plain output. */
export function isInteractionTool(name: string, semantic?: ToolSemantic): boolean {
  return (
    isTodoTool(name) ||
    isAskUserFormTool(name) ||
    isAskUserQuestionTool(name) ||
    isApprovalTool(name) ||
    isPushFileTool(name) ||
    isPlanModeTool(name, semantic)
  );
}

/**
 * The short name to show on a tool card. Bridged names are long and
 * server-specific (`mcp__acme__update_todo_list`); readers care about the
 * capability, so those collapse to the built-in spelling.
 */
export function toolDisplayName(name: string, semantic?: ToolSemantic): string {
  // A plan proposal's tool name (ExitPlanMode, mcp__x__exit_plan_mode) names
  // the mechanism; the reader cares that a plan is on offer.
  if (isPlanProposalTool(name, semantic)) return 'Plan proposal';
  if (isTodoTool(name)) return 'TodoWrite';
  if (isAskUserFormTool(name)) return 'AskUserForm';
  if (isApprovalTool(name)) return 'RequestApproval';
  if (isPushFileTool(name)) return 'PushFile';
  return name;
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

/** Coerce untyped todo payloads (array, or record with todos/items/list). */
export function normalizeTodoItems(value: unknown): TodoItemView[] {
  const normalized = normalizeToolInput(value);
  if (Array.isArray(normalized)) {
    return normalized.flatMap(item => {
      const record = asRecord(item);
      const content = record && typeof record.content === 'string' ? record.content : '';
      if (!content) return [];
      const status = String(record?.status ?? 'pending');
      return [{ content, status: (TODO_STATUSES.has(status) ? status : 'pending') as TodoItemView['status'] }];
    });
  }
  const record = asRecord(normalized);
  if (record) {
    for (const key of ['todos', 'items', 'list']) {
      if (Array.isArray(record[key])) return normalizeTodoItems(record[key]);
    }
  }
  return [];
}

// Caps keep presentations render-sized; hosts show full payloads elsewhere.
const MAX_COMMAND = 500;
const MAX_OUTPUT = 8_000;
const MAX_DIFF = 20_000;
const MAX_SEARCH_RESULTS = 8;

function printable(value: unknown, limit: number): string {
  if (typeof value === 'string') return value.trim().slice(0, limit);
  try {
    return JSON.stringify(value, null, 2).slice(0, limit);
  } catch {
    return String(value).slice(0, limit);
  }
}

function terminalOutput(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'string') return result.trim().slice(0, MAX_OUTPUT);
  const record = asRecord(result);
  if (!record) return printable(result, MAX_OUTPUT);
  const lines = Array.isArray(record.lines) ? record.lines.map(String).join('\n') : '';
  const output = record.output ?? record.stdout ?? record.stderr ?? lines;
  return String(output ?? '').trim().slice(0, MAX_OUTPUT);
}

function isImageUrl(value: string): boolean {
  return (
    value.startsWith('data:image/') ||
    /^https?:\/\/[^\s]+\.(png|jpe?g|gif|webp|svg|bmp)(\?[^\s]*)?$/i.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Find the result-item array in an untyped search result payload. */
function collectResultItems(value: unknown, depth = 0): unknown[] {
  if (depth > 3) return [];
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ['results', 'items', 'data', 'web', 'search_results']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    const nested = collectResultItems(candidate, depth + 1);
    if (nested.length > 0) return nested;
  }
  return [];
}

function searchResults(value: unknown): SearchResultView[] {
  return collectResultItems(value)
    .map(item => {
      const record = isRecord(item) ? item : {};
      const title = String(record.title ?? record.name ?? '').trim();
      const url = String(record.url ?? record.href ?? record.link ?? '').trim();
      const snippet = String(record.snippet ?? record.description ?? record.body ?? '').trim();
      return snippet ? { title, url, snippet } : { title, url };
    })
    .filter(item => item.url)
    .slice(0, MAX_SEARCH_RESULTS);
}

const TERMINAL_TOOLS = new Set(['Bash', 'BashOutput', 'terminal', 'execute_code', 'shell', 'run_command']);
const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'edit_file', 'patch', 'write_file']);
const LOCAL_SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const WEB_SEARCH_TOOLS = new Set(['WebSearch', 'web_search']);

export interface ToolCallLike {
  name: string;
  input?: unknown;
  result?: unknown;
}

/**
 * Map a finished tool call to a rendering presentation. Unknown tools fall
 * back to `generic` with a printable result.
 */
export function classifyTool(call: ToolCallLike): ToolPresentation {
  const name = call.name;
  const input = asRecord(call.input) ?? {};
  const resultRecord = asRecord(call.result);

  if (isTodoTool(name)) {
    const todos = normalizeTodoItems(input.todos ?? call.input);
    return { kind: 'todo', todos };
  }

  if (TERMINAL_TOOLS.has(name)) {
    const command = String(input.command ?? input.context ?? input.code ?? '').slice(0, MAX_COMMAND);
    const output = terminalOutput(call.result);
    const exitCode = resultRecord?.exit_code ?? resultRecord?.exitCode;
    return {
      kind: 'terminal',
      command,
      ...(output !== undefined ? { output } : {}),
      ...(typeof exitCode === 'number' ? { exitCode } : {}),
    };
  }

  if (FILE_EDIT_TOOLS.has(name)) {
    const filePath =
      extractFilePath(call.input) ??
      (typeof resultRecord?.path === 'string' ? resultRecord.path : '');
    const diff = String(resultRecord?.inline_diff ?? resultRecord?.diff ?? '').slice(0, MAX_DIFF);
    return {
      kind: 'file_edit',
      filePath,
      ...(diff ? { diff } : {}),
    };
  }

  if (LOCAL_SEARCH_TOOLS.has(name)) {
    const pattern = String(input.pattern ?? input.query ?? '');
    const query = input.path ? `${pattern} in ${String(input.path)}` : pattern;
    return { kind: 'search', query, results: searchResults(call.result) };
  }

  if (WEB_SEARCH_TOOLS.has(name)) {
    const query = String(input.query ?? input.search_term ?? input.context ?? '');
    return { kind: 'search', query, results: searchResults(call.result) };
  }

  if (name === 'image_generate' || name === 'generate_image') {
    const image = String(
      resultRecord?.host_image ?? resultRecord?.image ?? resultRecord?.agent_visible_image ?? '',
    );
    if (image && isImageUrl(image)) return { kind: 'image', url: image };
  }

  return {
    kind: 'generic',
    ...(call.result !== undefined ? { text: printable(call.result, MAX_OUTPUT) } : {}),
  };
}

/** First meaningful line of a proposed plan, heading marker stripped. */
function planSummary(input: Record<string, unknown>): string {
  const plan =
    typeof input.plan === 'string'
      ? input.plan
      : input.plan
        ? JSON.stringify(input.plan)
        : typeof input.plan_file === 'string'
          ? input.plan_file
          : Object.keys(input).length > 0
            ? JSON.stringify(input)
            : '';
  const firstLine =
    plan
      .split('\n')
      .find(line => line.trim())
      ?.replace(/^#+\s*/, '') || 'Plan ready for review';
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

/**
 * One line of "what is this call about", rendered next to the tool name in a
 * collapsed card header. Falls back to compact JSON for unknown tools.
 */
export function toolSummary(name: string, rawInput: unknown, semantic?: ToolSemantic): string {
  const input = asRecord(rawInput);
  if (!input) return '';
  if (isTodoTool(name)) return 'Update task list';
  if (isAskUserFormTool(name)) return String(input.title ?? '') || 'Form';
  if (isApprovalTool(name)) return String(input.title ?? '') || 'Approval required';
  if (isPushFileTool(name)) {
    const pushed = String(input.filePath ?? '');
    return pushed ? (pushed.split('/').pop() ?? pushed) : 'Push file';
  }
  if (semantic === 'plan_enter') return 'Entering plan mode';
  if (semantic === 'plan_exit') return 'Exiting plan mode';
  if (isPlanProposalTool(name, semantic)) return planSummary(input);
  // Specific tools before the set-based grouping below: MultiEdit is a
  // file-edit tool but summarizes by edit count, not by path alone.
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits.length : 0;
    return `${extractFilePath(input) ?? 'file'} | ${edits} edits`;
  }
  if (name === 'ReadSymbol' || name === 'EditSymbol') {
    const path = extractFilePath(input) ?? '';
    const symbol = String(input.symbol ?? '');
    return symbol ? `${path}#${symbol}` : path;
  }
  if (isAskUserQuestionTool(name)) {
    const raw = normalizeToolInput(input.questions);
    const count = Array.isArray(raw) ? raw.length : raw ? 1 : 0;
    return `${count} question${count === 1 ? '' : 's'}`;
  }
  if (TERMINAL_TOOLS.has(name)) {
    return String(input.command ?? input.context ?? input.code ?? '');
  }
  if (FILE_EDIT_TOOLS.has(name) || name === 'Read') {
    return extractFilePath(input) ?? '';
  }
  if (LOCAL_SEARCH_TOOLS.has(name)) {
    const pattern = String(input.pattern ?? input.query ?? '');
    return input.path ? `${pattern} in ${String(input.path)}` : pattern;
  }
  if (WEB_SEARCH_TOOLS.has(name)) {
    return String(input.query ?? input.search_term ?? '');
  }
  switch (name) {
    case 'Task':
    case 'Agent':
      return String(input.description ?? input.prompt ?? '');
    case 'WebFetch':
      return String(input.url ?? '');
    default: {
      try {
        const json = JSON.stringify(input);
        return json === '{}' ? '' : json;
      } catch {
        return '';
      }
    }
  }
}
