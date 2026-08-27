import { useState, memo } from 'react';
import { BrainIcon, ChevronRightIcon } from './icons.js';

/** One reasoning segment, as structured providers emit them. */
export interface ThinkingSegment {
  text: string;
  /** The provider withheld this segment; the card says so rather than hiding it. */
  redacted?: boolean;
}

export interface ThinkingBlockProps {
  /**
   * Reasoning as a plain string (parsed out of `<thinking>` tags) or as the
   * structured segments a provider streamed. Both shapes render the same card;
   * only the count label differs, because lines and blocks are different facts.
   */
  content: string | ThinkingSegment[];
}

/** Non-empty lines shown while the block is collapsed. */
const PREVIEW_LINES = 2;

function segmentsOf(content: string | ThinkingSegment[]): ThinkingSegment[] {
  return typeof content === 'string' ? [{ text: content }] : content;
}

/**
 * The agent's reasoning, collapsed by default.
 *
 * Reasoning is context, not the answer: it stays out of the way but visible
 * enough to be worth expanding, so the collapsed card shows its first couple
 * of lines and how much more there is.
 */
export const ThinkingBlock = memo(function ThinkingBlock({ content }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const segments = segmentsOf(content);
  if (segments.length === 0) return null;

  // Structured reasoning counts blocks, plain text counts lines — a reader
  // scanning a transcript wants to know how much there is in the unit the
  // provider actually produced.
  const isStructured = typeof content !== 'string';
  const nonEmptyLines = segments
    .flatMap(segment => segment.text.split('\n'))
    .filter(line => line.trim().length > 0);
  const count = isStructured ? segments.length : nonEmptyLines.length;
  const unit = isStructured ? 'block' : 'line';
  const preview = nonEmptyLines.slice(0, PREVIEW_LINES).join('\n');
  const hasMore = nonEmptyLines.length > PREVIEW_LINES;

  return (
    <div className="ztk-thinking">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="ztk-thinking__header"
        aria-expanded={expanded}
      >
        <BrainIcon size={14} />
        <span className={`ztk-thinking__chevron${expanded ? ' ztk-thinking__chevron--open' : ''}`}>
          <ChevronRightIcon size={12} />
        </span>
        <span className="ztk-thinking__label">Thinking</span>
        <span className="ztk-thinking__count">
          {count} {unit}
          {count === 1 ? '' : 's'}
        </span>
      </button>

      {!expanded && preview && (
        <div className="ztk-thinking__preview">
          {preview}
          {hasMore && <span className="ztk-thinking__ellipsis"> ...</span>}
        </div>
      )}

      {expanded && (
        <div className="ztk-thinking__body">
          {segments.map((segment, index) => (
            <div key={index} className="ztk-thinking__segment">
              {segment.redacted && (
                <span className="ztk-thinking__redacted">[Redacted by safety filter]</span>
              )}
              {segment.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
