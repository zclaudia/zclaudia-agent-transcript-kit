import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CodeBlock, TranscriptCapabilitiesProvider } from '../../src/react/index.js';
import type { TranscriptCapabilities } from '../../src/react/index.js';

function renderBlock(
  capabilities: TranscriptCapabilities = {},
  { language = 'bash', code = 'npm test' } = {},
) {
  return render(
    <TranscriptCapabilitiesProvider value={capabilities}>
      <CodeBlock language={language}>{code}</CodeBlock>
    </TranscriptCapabilitiesProvider>,
  );
}

describe('CodeBlock', () => {
  it('renders the language and the code with no capabilities at all', () => {
    // Every capability is optional; a host that provides none still gets a
    // readable block.
    render(<CodeBlock language="python">print(1)</CodeBlock>);
    expect(screen.getByText('python')).toBeInTheDocument();
    expect(screen.getByText('print(1)')).toBeInTheDocument();
  });

  it('offers "Run in terminal" only for shell code a host can actually run', () => {
    const runInTerminal = vi.fn();
    renderBlock({ runInTerminal });
    fireEvent.click(screen.getByText('Run in terminal'));
    expect(runInTerminal).toHaveBeenCalledWith('npm test');

    // Same capability, non-shell language: nothing to run.
    cleanupAnd(() => renderBlock({ runInTerminal }, { language: 'python' }));
    expect(screen.queryByText('Run in terminal')).not.toBeInTheDocument();

    // Shell code, but the host cannot reach a terminal.
    cleanupAnd(() => renderBlock({}));
    expect(screen.queryByText('Run in terminal')).not.toBeInTheDocument();
  });

  it('uses the host highlighter and falls back to plain text without one', () => {
    const highlightCode = vi.fn(() => <span data-testid="highlighted">tokens</span>);
    const { container } = renderBlock({ highlightCode }, { language: 'ts', code: 'const x = 1' });
    expect(highlightCode).toHaveBeenCalledWith('const x = 1', 'ts');
    expect(screen.getByTestId('highlighted')).toBeInTheDocument();
    // The kit owns the wrapper: exactly one <pre>, whatever the host returns.
    expect(container.querySelectorAll('pre')).toHaveLength(1);

    cleanupAnd(() => renderBlock({ highlightCode: () => undefined }, { code: 'raw text' }));
    expect(screen.getByText('raw text')).toBeInTheDocument();
  });

  it('confirms a copy and returns to its resting label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.useFakeTimers();
    try {
      renderBlock({}, { code: 'copy me' });
      fireEvent.click(screen.getByText('Copy code'));
      await vi.waitFor(() => expect(screen.getByText('Copied!')).toBeInTheDocument());
      expect(writeText).toHaveBeenCalledWith('copy me');

      // The confirmation is temporary — a stuck "Copied!" would lie about the
      // next copy.
      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => expect(screen.getByText('Copy code')).toBeInTheDocument());
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

/** Render fresh: these cases assert on absence, which needs a clean DOM. */
function cleanupAnd(render: () => void) {
  document.body.innerHTML = '';
  render();
}
