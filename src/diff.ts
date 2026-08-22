/**
 * Framework-free diff utilities for file-edit tool renderings.
 *
 * Two input shapes cover all three hosts:
 *  - old/new text pairs (Edit-style tools)     → diffLines() LCS line diff
 *  - pre-rendered unified diffs (patch tools)  → parseUnifiedDiff() classifier
 *
 * Design inputs:
 *  - intellij  ui/transcript/diff.tsx          (LCS + 400-line cap)
 *  - zclaudia  renderers/DiffViewer.tsx        (unified diff classifier, path extraction)
 *  - hermes    components/DiffLines.tsx        (ANSI stripping before classify)
 */

import { stripAnsi } from './text-utils.js';

export interface DiffLine {
  kind: 'context' | 'removed' | 'added';
  text: string;
}

/**
 * Past this many lines per side the LCS is skipped and the diff degrades to
 * plain removed/added runs — still readable, never a quadratic blowup on a
 * huge payload.
 */
export const MAX_DIFF_LINES = 400;

/** Line-based LCS diff of an old/new text pair. */
export function diffLines(
  oldText: string,
  newText: string,
  maxLines: number = MAX_DIFF_LINES,
): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  if (oldLines.length > maxLines || newLines.length > maxLines) {
    return [
      ...oldLines.map(text => ({ kind: 'removed' as const, text })),
      ...newLines.map(text => ({ kind: 'added' as const, text })),
    ];
  }
  if (oldText === newText) {
    return oldLines.map(text => ({ kind: 'context' as const, text }));
  }

  // Classic LCS table over lines.
  const rows = oldLines.length;
  const cols = newLines.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      lcs[row][col] =
        oldLines[row] === newLines[col]
          ? lcs[row + 1][col + 1] + 1
          : Math.max(lcs[row + 1][col], lcs[row][col + 1]);
    }
  }

  const result: DiffLine[] = [];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (oldLines[row] === newLines[col]) {
      result.push({ kind: 'context', text: oldLines[row] });
      row++;
      col++;
    } else if (lcs[row + 1][col] >= lcs[row][col + 1]) {
      result.push({ kind: 'removed', text: oldLines[row] });
      row++;
    } else {
      result.push({ kind: 'added', text: newLines[col] });
      col++;
    }
  }
  while (row < rows) result.push({ kind: 'removed', text: oldLines[row++] });
  while (col < cols) result.push({ kind: 'added', text: newLines[col++] });
  return result;
}

export interface UnifiedDiffLine {
  kind: 'context' | 'removed' | 'added' | 'hunk' | 'meta';
  text: string;
}

/**
 * Classify each line of a pre-rendered unified diff for per-line styling.
 * ANSI sequences are stripped first (some wires colorize their diffs).
 */
export function parseUnifiedDiff(diff: string): UnifiedDiffLine[] {
  return stripAnsi(diff)
    .split('\n')
    .map(text => {
      if (text.startsWith('@@')) return { kind: 'hunk' as const, text };
      if (
        text.startsWith('+++ ') ||
        text.startsWith('--- ') ||
        text.startsWith('diff ') ||
        text.startsWith('index ') ||
        text.startsWith('new file mode ') ||
        text.startsWith('deleted file mode ') ||
        text.startsWith('rename from ') ||
        text.startsWith('rename to ')
      ) {
        return { kind: 'meta' as const, text };
      }
      if (text.startsWith('+')) return { kind: 'added' as const, text };
      if (text.startsWith('-')) return { kind: 'removed' as const, text };
      return { kind: 'context' as const, text };
    });
}

/** Added/removed line counts for a diff header ("+3 −1"). */
export function diffStats(lines: readonly (DiffLine | UnifiedDiffLine)[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'added') added++;
    else if (line.kind === 'removed') removed++;
  }
  return { added, removed };
}

/** File path from a unified diff's +++/--- headers, a/ b/ prefixes dropped. */
export function extractUnifiedDiffPath(diff: string): string | undefined {
  const lines = diff.split('\n');
  const target =
    lines.find(line => line.startsWith('+++ ')) ??
    lines.find(line => line.startsWith('--- '));
  if (!target) return undefined;
  const path = target
    .replace(/^\+\+\+\s+|^---\s+/, '')
    .replace(/^[ab]\//, '')
    .trim();
  return path && path !== '/dev/null' ? path : undefined;
}
