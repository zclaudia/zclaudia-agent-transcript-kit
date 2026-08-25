import { useState, memo } from 'react';
import { useTranscriptCapabilities } from './capabilities.js';
import { CheckIcon, CopyIcon, TerminalIcon } from './icons.js';

const SHELL_LANGUAGES = new Set(['bash', 'shell', 'sh', 'zsh']);

/** How long the copy button stays in its confirmed state. */
const COPIED_FEEDBACK_MS = 2000;

export interface CodeBlockProps {
  language: string;
  children: string;
}

/**
 * Fenced code block: language label, copy action, and — when the host offers
 * a terminal and the language is a shell — a run-in-terminal action.
 *
 * Highlighting is the host's (see `highlightCode` in TranscriptCapabilities);
 * without it the code renders as plain text. Colors come from the `--ztk-*`
 * custom properties, so a host themes this by mapping its own tokens once
 * rather than by passing theme props down.
 *
 * Memoized: while a message streams, only the block whose code changed should
 * re-run the host's (expensive) tokenizer.
 */
export const CodeBlock = memo(function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const { runInTerminal, highlightCode } = useTranscriptCapabilities();
  const isShell = SHELL_LANGUAGES.has(language.toLowerCase());
  const canRunInTerminal = isShell && Boolean(runInTerminal);

  const handleCopy = () => {
    void navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    });
  };

  const highlighted = highlightCode?.(children, language);

  return (
    <div className="ztk-code-block">
      <div className="ztk-code-block__header">
        <span className="ztk-code-block__language">{language}</span>
        <div className="ztk-code-block__actions">
          {canRunInTerminal && (
            <button
              type="button"
              onClick={() => runInTerminal?.(children)}
              className="ztk-code-block__action"
            >
              <TerminalIcon />
              Run in terminal
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className={`ztk-code-block__action${copied ? ' ztk-code-block__action--done' : ''}`}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? 'Copied!' : 'Copy code'}
          </button>
        </div>
      </div>
      <div className="ztk-code-block__body ztk-code">
        <pre className="ztk-code-block__pre">
          <code>{highlighted ?? children}</code>
        </pre>
      </div>
    </div>
  );
});

export { SHELL_LANGUAGES };
