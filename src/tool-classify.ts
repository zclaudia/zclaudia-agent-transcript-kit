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

/** Todo-list tools: built-in TodoWrite plus MCP update_todo_list variants. */
export function isTodoTool(name: string): boolean {
  if (name === 'TodoWrite') return true;
  if (/(?:^|[_\-:])update_todo_list$/.test(name)) return true;
  const normalized = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'updatetodos' || normalized === 'todolist' || normalized === 'todolistwrite';
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

/**
 * One line of "what is this call about", rendered next to the tool name in a
 * collapsed card header. Falls back to compact JSON for unknown tools.
 */
export function toolSummary(name: string, rawInput: unknown): string {
  const input = asRecord(rawInput);
  if (!input) return '';
  if (isTodoTool(name)) return 'Update task list';
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
