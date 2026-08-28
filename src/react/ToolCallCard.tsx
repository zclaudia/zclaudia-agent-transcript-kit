import { useState, useEffect, useRef, memo, type ReactNode } from 'react';
import type { ToolCallView } from '../transcript.js';
import { isPlanProposalTool, toolDisplayName, toolSummary } from '../tool-classify.js';
import { useTranscriptCapabilities } from './capabilities.js';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SendToBackIcon,
  SpinnerIcon,
  WrenchIcon,
  XCircleIcon,
} from './icons.js';

export interface ToolCallCardProps {
  toolCall: ToolCallView;
  /**
   * Host capability: move this running command to the background. Present ⇒ a
   * running shell card offers "Send to background".
   */
  onSendToBackground?: () => void;
  /**
   * The tool-specific expanded body. A render prop rather than children so it
   * is only built when the card is actually open — expanded bodies parse
   * results, render diffs, and decode images.
   */
  renderExpanded?: () => ReactNode;
}

const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'terminal', 'shell', 'run_command']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * A tool call in the transcript: status, name, one-line summary, and a
 * collapsible body.
 *
 * The card owns presentation that is the same everywhere — status glyph,
 * expand/collapse, the plan-proposal auto-expand, the background affordance —
 * and delegates what genuinely differs: the tool icon and the expanded body
 * both come from the host. Everything else is derived from the kit's own
 * classifiers, so a bridged `mcp__acme__update_todo_list` reads as `TodoWrite`
 * in every host.
 */
export const ToolCallCard = memo(function ToolCallCard({
  toolCall,
  onSendToBackground,
  renderExpanded,
}: ToolCallCardProps) {
  const { name, input, semantic, summary: activity } = toolCall;
  const isPlanProposal = isPlanProposalTool(name, semantic);
  const isSettled = toolCall.status !== 'running';

  // A finished plan proposal opens itself: the plan body and its approval
  // controls are the point of the card, not a detail behind a click. It only
  // auto-opens once, so a reader who collapses it keeps it collapsed.
  const [isExpanded, setIsExpanded] = useState(() => isPlanProposal && isSettled);
  const autoExpandedRef = useRef(isPlanProposal && isSettled);
  useEffect(() => {
    if (autoExpandedRef.current || !isPlanProposal || !isSettled) return;
    autoExpandedRef.current = true;
    setIsExpanded(true);
  }, [isPlanProposal, isSettled]);

  const [backgroundRequested, setBackgroundRequested] = useState(false);
  const { toolIcon } = useTranscriptCapabilities();

  const running = toolCall.status === 'running';
  // `AskUserQuestion` answers arrive as a denial, which is the user answering,
  // not a failure — the card must not shout about it.
  const showAsError =
    (toolCall.status === 'error' || toolCall.status === 'cancelled') && name !== 'AskUserQuestion';
  const state = running ? 'running' : showAsError ? 'error' : 'done';

  return (
    // `data-status` is the public hook for this card's visual state: hosts
    // style against it and tests assert on it, so the class names underneath
    // stay free to change.
    <div
      className={`ztk-tool-card ztk-tool-card--${state}`}
      data-status={state}
      data-testid="tool-use"
    >
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="ztk-tool-card__header"
        aria-expanded={isExpanded}
      >
        <span className="ztk-tool-card__status">
          {running ? <SpinnerIcon size={14} /> : showAsError ? <XCircleIcon size={14} /> : <CheckCircleIcon size={14} />}
        </span>
        <span className="ztk-tool-card__icon">{toolIcon?.(name) ?? <WrenchIcon size={14} />}</span>
        <span className="ztk-tool-card__name" data-testid="tool-name">
          {toolDisplayName(name, semantic)}
        </span>
        <span className="ztk-tool-card__summary">{toolSummary(name, input, semantic)}</span>
        <span className="ztk-tool-card__chevron">
          {isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      </button>

      {running && onSendToBackground && SHELL_TOOLS.has(name) && (
        <div className="ztk-tool-card__aside ztk-tool-card__aside--indented">
          <button
            type="button"
            onClick={event => {
              event.stopPropagation();
              if (backgroundRequested) return;
              setBackgroundRequested(true);
              onSendToBackground();
            }}
            disabled={backgroundRequested}
            className="ztk-tool-card__background-button"
          >
            <SendToBackIcon size={11} />
            {backgroundRequested ? 'Moving to background…' : 'Send to background'}
          </button>
        </div>
      )}

      {running && activity && SUBAGENT_TOOLS.has(name) && (
        <div className="ztk-tool-card__aside">
          <div className="ztk-tool-card__activity">{activity}</div>
        </div>
      )}

      {isExpanded && renderExpanded && (
        <div className="ztk-tool-card__body">{renderExpanded()}</div>
      )}
    </div>
  );
});
