import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InteractionCard, TranscriptCapabilitiesProvider } from '../../src/react/index.js';
import type { InteractionRequest, InteractionResponse } from '../../src/interaction.js';

function renderCard(request: InteractionRequest, busy = false) {
  const onRespond = vi.fn<(response: InteractionResponse) => void>();
  const result = render(<InteractionCard request={request} onRespond={onRespond} busy={busy} />);
  return { onRespond, ...result };
}

describe('InteractionCard · approval', () => {
  it('offers a plain allow when the host declares no scopes', () => {
    const { onRespond } = renderCard({ kind: 'approval', id: 'i1', command: 'rm -rf build' });
    expect(screen.getByText('rm -rf build')).toBeInTheDocument();
    expect(screen.queryByText('Always allow')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Allow'));
    expect(onRespond).toHaveBeenCalledWith({ kind: 'approval', decision: 'allow' });
  });

  it('offers exactly the scopes the host said it supports', () => {
    // A scope the host cannot honor must not be offered: the reader would be
    // choosing something that silently does not happen.
    const { onRespond } = renderCard({
      kind: 'approval',
      id: 'i1',
      allowedScopes: ['once', 'session'],
    });
    expect(screen.getByText('Allow once')).toBeInTheDocument();
    expect(screen.getByText('Allow for session')).toBeInTheDocument();
    expect(screen.queryByText('Always allow')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Allow for session'));
    expect(onRespond).toHaveBeenCalledWith({
      kind: 'approval',
      decision: 'allow',
      scope: 'session',
    });
  });

  it('only lets the input be edited where an edit can be honored', () => {
    const input = { command: 'ls' };
    renderCard({ kind: 'approval', id: 'i1', toolInput: input });
    expect(screen.queryByLabelText('Tool input')).not.toBeInTheDocument();

    document.body.innerHTML = '';
    const { onRespond } = renderCard({
      kind: 'approval',
      id: 'i1',
      toolInput: input,
      editableInput: true,
    });
    fireEvent.change(screen.getByLabelText('Tool input'), {
      target: { value: '{"command":"ls -la"}' },
    });
    fireEvent.click(screen.getByText('Allow'));
    expect(onRespond).toHaveBeenCalledWith({
      kind: 'approval',
      decision: 'allow',
      updatedInput: { command: 'ls -la' },
    });
  });

  it('keeps an edit that is not valid JSON rather than discarding it', () => {
    const { onRespond } = renderCard({
      kind: 'approval',
      id: 'i1',
      toolInput: { command: 'ls' },
      editableInput: true,
    });
    fireEvent.change(screen.getByLabelText('Tool input'), { target: { value: 'ls -la' } });
    fireEvent.click(screen.getByText('Allow'));
    expect(onRespond).toHaveBeenCalledWith({
      kind: 'approval',
      decision: 'allow',
      updatedInput: 'ls -la',
    });
  });

  it('says what happens if nobody answers', () => {
    renderCard({ kind: 'approval', id: 'i1', timeoutSeconds: 60 });
    expect(screen.getByText(/Denies automatically after 60s/)).toBeInTheDocument();

    document.body.innerHTML = '';
    renderCard({ kind: 'approval', id: 'i1', timeoutSeconds: 30, timeoutBehavior: 'approve' });
    expect(screen.getByText(/Approves automatically after 30s/)).toBeInTheDocument();
  });

  it('locks its controls while a response is being delivered', () => {
    renderCard({ kind: 'approval', id: 'i1' }, true);
    expect(screen.getByText('Allow')).toBeDisabled();
    expect(screen.getByText('Deny')).toBeDisabled();
  });
});

describe('InteractionCard · question', () => {
  const twoQuestions: InteractionRequest = {
    kind: 'question',
    id: 'i1',
    questions: [
      { question: 'Pick one', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      {
        question: 'Pick many',
        multiSelect: true,
        options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }],
      },
    ],
  };

  it('will not submit until every question is answered', () => {
    // A half-answer would resume the agent on a premise the reader never gave.
    renderCard(twoQuestions);
    const submit = screen.getByText('Submit');
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByLabelText('A'));
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByLabelText('X'));
    expect(submit).toBeEnabled();
  });

  it('keeps single-choice single and multi-choice additive', () => {
    const { onRespond } = renderCard(twoQuestions);
    fireEvent.click(screen.getByLabelText('A'));
    fireEvent.click(screen.getByLabelText('B'));
    fireEvent.click(screen.getByLabelText('X'));
    fireEvent.click(screen.getByLabelText('Y'));
    fireEvent.click(screen.getByText('Submit'));

    expect(onRespond).toHaveBeenCalledWith({
      kind: 'question',
      answers: [
        { questionIndex: 0, values: ['b'] },
        { questionIndex: 1, values: ['x', 'y'] },
      ],
    });
  });

  it('requires text once "Other" is chosen', () => {
    const { onRespond } = renderCard({
      kind: 'question',
      id: 'i1',
      questions: [
        { question: 'Why?', options: [{ value: 'a', label: 'A' }], allowCustomValue: true },
      ],
    });
    fireEvent.click(screen.getByLabelText('Other'));
    expect(screen.getByText('Submit')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'because' } });
    fireEvent.click(screen.getByText('Submit'));
    expect(onRespond).toHaveBeenCalledWith({
      kind: 'question',
      answers: [{ questionIndex: 0, values: ['because'] }],
    });
  });

  it('goes straight to free text when there is nothing to choose from', () => {
    // An open question (hermes clarify) arrives with no options at all.
    renderCard({ kind: 'question', id: 'i1', questions: [{ question: 'Which file?', options: [] }] });
    expect(screen.getByLabelText('Your answer')).toBeInTheDocument();
    expect(screen.queryByLabelText('Other')).not.toBeInTheDocument();
    expect(screen.getByText('Submit')).toBeDisabled();
  });
});

describe('InteractionCard · form', () => {
  it('holds submission until required fields are filled', () => {
    const { onRespond } = renderCard({
      kind: 'form',
      id: 'i1',
      title: 'Configure',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        { id: 'notes', label: 'Notes', type: 'textarea' },
        { id: 'agree', label: 'Agree', type: 'confirm' },
      ],
    });
    expect(screen.getByText('Submit')).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'thing' } });
    fireEvent.click(screen.getByLabelText('Agree'));
    fireEvent.click(screen.getByText('Submit'));

    expect(onRespond).toHaveBeenCalledWith({
      kind: 'form',
      values: { name: 'thing', notes: '', agree: true },
    });
  });

  it('cancels without collecting what was typed', () => {
    const { onRespond } = renderCard({
      kind: 'form',
      id: 'i1',
      title: 'Configure',
      fields: [{ id: 'name', label: 'Name', type: 'text' }],
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'typed' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(onRespond).toHaveBeenCalledWith({ kind: 'form', values: {} });
  });

  it('starts a multiselect empty and accumulates choices', () => {
    const { onRespond } = renderCard({
      kind: 'form',
      id: 'i1',
      title: 'Pick',
      fields: [
        {
          id: 'langs',
          label: 'Languages',
          type: 'multiselect',
          options: [{ value: 'ts', label: 'TS' }, { value: 'go', label: 'Go' }],
        },
      ],
    });
    fireEvent.click(screen.getByLabelText('TS'));
    fireEvent.click(screen.getByLabelText('Go'));
    fireEvent.click(screen.getByText('Submit'));
    expect(onRespond).toHaveBeenCalledWith({ kind: 'form', values: { langs: ['ts', 'go'] } });
  });
});

describe('InteractionCard · plan review', () => {
  const plan: InteractionRequest = {
    kind: 'plan_review',
    id: 'i1',
    plan: '# Refactor\nstep one',
    todos: [{ content: 'done thing', status: 'completed' }],
  };

  it('renders the plan through the host renderer when there is one', () => {
    const renderMarkdown = vi.fn(() => <div data-testid="md">rendered</div>);
    render(
      <TranscriptCapabilitiesProvider value={{ renderMarkdown }}>
        <InteractionCard request={plan} onRespond={vi.fn()} />
      </TranscriptCapabilitiesProvider>,
    );
    expect(renderMarkdown).toHaveBeenCalledWith('# Refactor\nstep one');
    expect(screen.getByTestId('md')).toBeInTheDocument();
  });

  it('shows the plan as written when no renderer is provided', () => {
    renderCard(plan);
    expect(screen.getByText(/# Refactor/)).toBeInTheDocument();
    expect(screen.getByText('done thing')).toBeInTheDocument();
  });

  it('carries feedback with either decision, and omits it when blank', () => {
    const { onRespond } = renderCard(plan);
    fireEvent.click(screen.getByText('Approve'));
    expect(onRespond).toHaveBeenCalledWith({ kind: 'plan_review', decision: 'approve' });

    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'narrow it down' } });
    fireEvent.click(screen.getByText('Request changes'));
    expect(onRespond).toHaveBeenLastCalledWith({
      kind: 'plan_review',
      decision: 'reject',
      feedback: 'narrow it down',
    });
  });
});

describe('InteractionCard · secret', () => {
  it('never shows the value, and drops it once handed over', () => {
    const { onRespond } = renderCard({ kind: 'secret_input', id: 'i1', secretKind: 'password' });
    const field = screen.getByLabelText('Password') as HTMLInputElement;
    // A secret must not be readable off the screen or left in the DOM after.
    expect(field.type).toBe('password');
    expect(field).toHaveAttribute('autocomplete', 'off');

    fireEvent.change(field, { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByText('Submit'));
    expect(onRespond).toHaveBeenCalledWith({ kind: 'secret_input', value: 'hunter2' });
    expect(field.value).toBe('');
  });

  it('names the variable when one is being asked for', () => {
    renderCard({ kind: 'secret_input', id: 'i1', secretKind: 'env_var', envVar: 'API_KEY' });
    expect(screen.getByLabelText('Value for API_KEY')).toBeInTheDocument();
  });

  it('refuses to submit an empty secret', () => {
    renderCard({ kind: 'secret_input', id: 'i1', secretKind: 'password' });
    expect(screen.getByText('Submit')).toBeDisabled();
  });
});
