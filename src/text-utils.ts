/**
 * Pure text utilities shared by all hosts — each of the three apps had its own
 * copy of these (hermes message-content.ts, intellij splitThinkTags +
 * stabilizeStreamingMarkdown, zclaudia messageContent.ts).
 */

/**
 * Merge a streamed text update into the accumulated string.
 *
 * Non-snapshot: plain append. Snapshot (legacy providers emit a final full
 * value after deltas): a full-prefix value replaces, an already-present
 * suffix is a replay and is ignored, anything else appends. The result always
 * starts with `current`, so callers can derive the appended suffix with
 * `merged.slice(current.length)`.
 */
export function mergeStreamText(
  current: string,
  incoming: string,
  isSnapshot: boolean,
): string {
  if (!incoming) return current;
  if (!isSnapshot) return current + incoming;
  if (incoming.startsWith(current)) return incoming;
  if (current.endsWith(incoming)) return current;
  return current + incoming;
}

export interface ThinkSplit {
  /** Text outside <think>/<thinking> tags. */
  visible: string;
  /** Concatenated contents of all think segments. */
  thinking: string;
  /** Each think segment's raw content, in order (hosts join for display). */
  thinkingSegments: string[];
  /** True when the last think tag is unclosed (thinking is still streaming). */
  thinkingOpen: boolean;
}

/**
 * Strip inline `<think>` / `<thinking>` tag blocks from model text. An
 * unclosed open tag means the model is mid-thought: everything after it is
 * thinking and `thinkingOpen` is set.
 */
export function splitThinkTags(text: string): ThinkSplit {
  const openRe = /<think(?:ing)?>/i;
  const closeRe = /<\/think(?:ing)?>/i;
  let visible = '';
  const thinkingSegments: string[] = [];
  let rest = text;
  for (;;) {
    const open = openRe.exec(rest);
    if (!open) {
      visible += rest;
      return {
        visible,
        thinking: thinkingSegments.join(''),
        thinkingSegments,
        thinkingOpen: false,
      };
    }
    visible += rest.slice(0, open.index);
    const afterOpen = rest.slice(open.index + open[0].length);
    const close = closeRe.exec(afterOpen);
    if (!close) {
      thinkingSegments.push(afterOpen);
      return {
        visible,
        thinking: thinkingSegments.join(''),
        thinkingSegments,
        thinkingOpen: true,
      };
    }
    thinkingSegments.push(afterOpen.slice(0, close.index));
    rest = afterOpen.slice(close.index + close[0].length);
  }
}

/**
 * Strip ANSI escape sequences (colors, cursor movement, erase) from terminal
 * output — every host restyles tool output itself. Covers CSI sequences
 * (`ESC [ ... letter`), the form all three apps were stripping.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Close a dangling code fence so react-markdown does not restyle the whole
 * tail of a streaming message as code. Applied at render time only — the
 * stored text is never modified.
 */
export function stabilizeStreamingMarkdown(text: string): string {
  let openFence: string | null = null;
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!match) continue;
    const fence = match[1];
    if (openFence === null) {
      openFence = fence;
    } else if (fence[0] === openFence[0] && fence.length >= openFence.length) {
      openFence = null;
    }
  }
  if (openFence === null) return text;
  const close = openFence[0].repeat(Math.max(3, openFence.length));
  return `${text}\n${close}`;
}
