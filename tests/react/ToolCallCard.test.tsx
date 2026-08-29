import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToolCallCard, TranscriptCapabilitiesProvider } from '../../src/react/index.js';
import type { TranscriptCapabilities } from '../../src/react/index.js';
import type { ToolCallView } from '../../src/transcript.js';

const call = (overrides: Partial<ToolCallView> = {}): ToolCallView => ({
  id: 't1',
  name: 'Bash',
  status: 'running',
  input: { command: 'npm test' },
  ...overrides,
});

function renderCard(
  toolCall: ToolCallView,
  props: { onSendToBackground?: () => void; renderExpanded?: () => React.ReactNode } = {},
  capabilities: TranscriptCapabilities = {},
) {
  return render(
    <TranscriptCapabilitiesProvider value={capabilities}>
      <ToolCallCard toolCall={toolCall} {...props} />
    </TranscriptCapabilitiesProvider>,
  );
}

describe('ToolCallCard', () => {
  it('publishes its state so hosts can style and assert on it', () => {
    const { rerender } = renderCard(call({ status: 'running' }));
    expect(screen.getByTestId('tool-use')).toHaveAttribute('data-status', 'running');

    for (const [status, expected] of [
      ['success', 'done'],
      ['error', 'error'],
      ['cancelled', 'error'],
    ] as const) {
      rerender(
        <TranscriptCapabilitiesProvider value={{}}>
          <ToolCallCard toolCall={call({ status })} />
        </TranscriptCapabilitiesProvider>,
      );
      expect(screen.getByTestId('tool-use')).toHaveAttribute('data-status', expected);
    }
  });

  it('does not dress an answered question up as a failure', () => {
    // AskUserQuestion returns a denial when the user answers; that is the
    // feature working, not an error.
    renderCard(call({ name: 'AskUserQuestion', status: 'error' }));
    expect(screen.getByTestId('tool-use')).toHaveAttribute('data-status', 'done');
  });

  it('shows the capability behind a bridged name, and what the call is about', () => {
    renderCard(call({ name: 'mcp__acme__update_todo_list', status: 'success', input: {} }));
    expect(screen.getByTestId('tool-name')).toHaveTextContent('TodoWrite');
    expect(screen.getByText('Update task list')).toBeInTheDocument();
  });

  it('builds the expanded body only once opened', () => {
    // Expanded bodies parse results, render diffs, decode images — none of
    // that should happen for a card nobody opened.
    const renderExpanded = vi.fn(() => <div>expanded body</div>);
    renderCard(call(), { renderExpanded });
    expect(renderExpanded).not.toHaveBeenCalled();
    expect(screen.queryByText('expanded body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
    expect(screen.getByText('expanded body')).toBeInTheDocument();
  });

  it('names a plan by what it offers, not by the tool that produced it', () => {
    renderCard(call({ name: 'ExitPlanMode', semantic: 'plan_proposal', status: 'success', input: { plan: '# Refactor the parser' } }));
    // The reader cares that a plan is on offer, not that ExitPlanMode ran.
    expect(screen.getByTestId('tool-name')).toHaveTextContent('Plan proposal');
    expect(screen.getByText('Refactor the parser')).toBeInTheDocument();
  });

  it('opens a finished plan proposal, and lets the reader close it for good', () => {
    const renderExpanded = () => <div>the plan</div>;
    const { rerender } = renderCard(
      call({ name: 'ExitPlanMode', semantic: 'plan_proposal', status: 'running' }),
      { renderExpanded },
    );
    expect(screen.queryByText('the plan')).not.toBeInTheDocument();

    // The plan and its approval controls are the point of this card, so it
    // opens itself the moment there is a plan to read.
    const finished = (
      <TranscriptCapabilitiesProvider value={{}}>
        <ToolCallCard
          toolCall={call({ name: 'ExitPlanMode', semantic: 'plan_proposal', status: 'success' })}
          renderExpanded={renderExpanded}
        />
      </TranscriptCapabilitiesProvider>
    );
    rerender(finished);
    expect(screen.getByText('the plan')).toBeInTheDocument();

    // Auto-open happens once: a reader who collapses it keeps it collapsed.
    fireEvent.click(screen.getByRole('button', { name: /Plan proposal/ }));
    expect(screen.queryByText('the plan')).not.toBeInTheDocument();
    rerender(finished);
    expect(screen.queryByText('the plan')).not.toBeInTheDocument();
  });

  it('offers to background a running command, once', () => {
    const onSendToBackground = vi.fn();
    renderCard(call({ name: 'Bash', status: 'running' }), { onSendToBackground });
    const button = screen.getByText('Send to background');

    fireEvent.click(button);
    expect(onSendToBackground).toHaveBeenCalledTimes(1);
    // The request is in flight; clicking again would send a second one.
    expect(screen.getByText('Moving to background…')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Moving to background…'));
    expect(onSendToBackground).toHaveBeenCalledTimes(1);
  });

  it('withholds the background affordance where it would not apply', () => {
    // A finished command cannot be backgrounded, and neither can a tool that
    // is not a command.
    renderCard(call({ status: 'success' }), { onSendToBackground: vi.fn() });
    expect(screen.queryByText('Send to background')).not.toBeInTheDocument();

    document.body.innerHTML = '';
    renderCard(call({ name: 'Read', status: 'running' }), { onSendToBackground: vi.fn() });
    expect(screen.queryByText('Send to background')).not.toBeInTheDocument();

    document.body.innerHTML = '';
    renderCard(call({ name: 'Bash', status: 'running' }));
    expect(screen.queryByText('Send to background')).not.toBeInTheDocument();
  });

  it('reports what a subagent is doing while it runs', () => {
    renderCard(call({ name: 'Agent', status: 'running', summary: 'Reading config' }));
    expect(screen.getByText('Reading config')).toBeInTheDocument();
  });

  it('renders the host icon when there is one, and a generic glyph otherwise', () => {
    const toolIcon = vi.fn(() => <span data-testid="host-icon" />);
    renderCard(call(), {}, { toolIcon });
    expect(toolIcon).toHaveBeenCalledWith('Bash');
    expect(screen.getByTestId('host-icon')).toBeInTheDocument();

    document.body.innerHTML = '';
    const { container } = renderCard(call(), {}, { toolIcon: () => undefined });
    expect(container.querySelector('.ztk-tool-card__icon svg')).toBeInTheDocument();
  });
});
