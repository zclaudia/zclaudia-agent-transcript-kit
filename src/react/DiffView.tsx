import { useMemo, memo } from 'react';
import {
  diffLines,
  diffStats,
  extractUnifiedDiffPath,
  parseUnifiedDiff,
  type DiffLine,
  type UnifiedDiffLine,
} from '../diff.js';

export type DiffViewProps = {
  /** Shown in the header; for unified input it falls back to the diff's own header. */
  filePath?: string;
} & (
  | {
      /** Compare two revisions of a file — the kit computes the line diff. */
      oldText: string;
      newText: string;
      unified?: never;
    }
  | {
      /** A diff the agent already rendered; parsed rather than recomputed. */
      unified: string;
      oldText?: never;
      newText?: never;
    }
);

function basename(path: string | undefined): string {
  if (!path) return 'diff';
  return path.split('/').filter(Boolean).pop() || path;
}

/**
 * A file change, as a diff.
 *
 * Takes either two revisions or a diff the agent already produced. Computed
 * diffs get a marker column, since their lines carry no +/- of their own;
 * unified input keeps its own markers and its hunk headers.
 */
export const DiffView = memo(function DiffView(props: DiffViewProps) {
  const { filePath } = props;
  const isUnified = props.unified !== undefined;

  const lines = useMemo<Array<DiffLine | UnifiedDiffLine>>(
    () =>
      props.unified !== undefined
        ? parseUnifiedDiff(props.unified)
        : diffLines(props.oldText, props.newText),
    [props.unified, props.oldText, props.newText]
  );

  const { added, removed } = diffStats(lines);
  const displayPath =
    filePath ?? (props.unified !== undefined ? extractUnifiedDiffPath(props.unified) : undefined);

  return (
    <div className="ztk-diff">
      <div className="ztk-diff__header">
        <span className="ztk-diff__path" title={displayPath}>
          {basename(displayPath)}
        </span>
        <span className="ztk-diff__stats">
          {removed > 0 && <span className="ztk-diff__stat--removed">−{removed}</span>}
          {added > 0 && <span className="ztk-diff__stat--added">+{added}</span>}
        </span>
      </div>

      <div className="ztk-diff__body">
        <pre className="ztk-diff__pre">
          {lines.map((line, index) => (
            <div key={index} className={`ztk-diff__line ztk-diff__line--${line.kind}`}>
              {!isUnified && (
                <span className="ztk-diff__marker" aria-hidden>
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                </span>
              )}
              {/* A blank line still needs to occupy a row. */}
              <span>{line.text || ' '}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
});
