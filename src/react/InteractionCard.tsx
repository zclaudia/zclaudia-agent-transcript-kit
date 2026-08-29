import { useState, type ReactNode } from 'react';
import type {
  ApprovalRequest,
  ApprovalScope,
  FormField,
  FormRequest,
  InteractionRequest,
  InteractionResponse,
  PlanReviewRequest,
  QuestionRequest,
  SecretInputRequest,
} from '../interaction.js';
import { useTranscriptCapabilities } from './capabilities.js';

export interface InteractionCardProps {
  request: InteractionRequest;
  /**
   * The user's answer. Synchronous: sending it is the host's job, and so is
   * whatever it does while the send is in flight.
   */
  onRespond: (response: InteractionResponse) => void;
  /** Host is delivering a response; controls lock so it cannot be sent twice. */
  busy?: boolean;
}

const SCOPE_LABELS: Record<ApprovalScope, string> = {
  once: 'Allow once',
  session: 'Allow for session',
  always: 'Always allow',
};

/**
 * A blocking request for the reader's decision.
 *
 * The agent stops until this is answered, so the card states what is being
 * asked, offers only what the host actually supports, and refuses to submit
 * an answer the request would reject.
 *
 * Capabilities are declared per request rather than assumed: an approval only
 * offers scopes the host listed, only allows editing the input when the host
 * can honor an edit, and only counts down when the host will act on the
 * timeout.
 */
export function InteractionCard({ request, onRespond, busy = false }: InteractionCardProps) {
  return (
    <div className="ztk-interaction" data-kind={request.kind}>
      {renderBody(request, onRespond, busy)}
    </div>
  );
}

function renderBody(
  request: InteractionRequest,
  onRespond: (response: InteractionResponse) => void,
  busy: boolean,
): ReactNode {
  switch (request.kind) {
    case 'approval':
      return <ApprovalBody request={request} onRespond={onRespond} busy={busy} />;
    case 'question':
      return <QuestionBody request={request} onRespond={onRespond} busy={busy} />;
    case 'form':
      return <FormBody request={request} onRespond={onRespond} busy={busy} />;
    case 'plan_review':
      return <PlanReviewBody request={request} onRespond={onRespond} busy={busy} />;
    case 'secret_input':
      return <SecretBody request={request} onRespond={onRespond} busy={busy} />;
  }
}

function Header({ title, description }: { title: string; description?: string }) {
  return (
    <div className="ztk-interaction__header">
      <div className="ztk-interaction__title">{title}</div>
      {description && <div className="ztk-interaction__description">{description}</div>}
    </div>
  );
}

// ── Approval ────────────────────────────────────────────────────

function ApprovalBody({
  request,
  onRespond,
  busy,
}: {
  request: ApprovalRequest;
  onRespond: (response: InteractionResponse) => void;
  busy: boolean;
}) {
  const [editedInput, setEditedInput] = useState<string | null>(null);
  const scopes = request.allowedScopes ?? [];
  const allow = (scope?: ApprovalScope) => {
    let updatedInput: unknown;
    if (request.editableInput && editedInput !== null) {
      try {
        updatedInput = JSON.parse(editedInput);
      } catch {
        // Not valid JSON: send the text as typed rather than dropping the edit.
        updatedInput = editedInput;
      }
    }
    onRespond({
      kind: 'approval',
      decision: 'allow',
      ...(scope ? { scope } : {}),
      ...(updatedInput !== undefined ? { updatedInput } : {}),
    });
  };

  return (
    <>
      <Header
        title={request.title ?? (request.toolName ? `Permission required · ${request.toolName}` : 'Permission required')}
        description={request.description}
      />
      {request.command && <pre className="ztk-interaction__command">{request.command}</pre>}
      {request.editableInput && request.toolInput !== undefined && (
        <textarea
          className="ztk-interaction__input ztk-interaction__input--code"
          aria-label="Tool input"
          value={editedInput ?? JSON.stringify(request.toolInput, null, 2)}
          onChange={event => setEditedInput(event.target.value)}
          rows={5}
        />
      )}
      {request.timeoutSeconds !== undefined && (
        <Countdown
          seconds={request.timeoutSeconds}
          behavior={request.timeoutBehavior ?? 'deny'}
        />
      )}
      <div className="ztk-interaction__actions">
        <button
          type="button"
          className="ztk-interaction__button"
          disabled={busy}
          onClick={() => onRespond({ kind: 'approval', decision: 'deny' })}
        >
          {request.rejectLabel ?? 'Deny'}
        </button>
        {scopes.length > 0 ? (
          scopes.map(scope => (
            <button
              key={scope}
              type="button"
              className="ztk-interaction__button ztk-interaction__button--primary"
              disabled={busy}
              onClick={() => allow(scope)}
            >
              {SCOPE_LABELS[scope]}
            </button>
          ))
        ) : (
          <button
            type="button"
            className="ztk-interaction__button ztk-interaction__button--primary"
            disabled={busy}
            onClick={() => allow()}
          >
            {request.approveLabel ?? 'Allow'}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * What happens if nobody answers. Static text rather than a live tick: the
 * host owns the clock and resolves the interaction itself, and a second
 * countdown here could disagree with it.
 */
function Countdown({ seconds, behavior }: { seconds: number; behavior: 'approve' | 'deny' }) {
  return (
    <div className="ztk-interaction__timeout">
      {behavior === 'approve' ? 'Approves' : 'Denies'} automatically after {seconds}s
    </div>
  );
}

// ── Question ────────────────────────────────────────────────────

const OTHER = '__ztk_other__';

function QuestionBody({
  request,
  onRespond,
  busy,
}: {
  request: QuestionRequest;
  onRespond: (response: InteractionResponse) => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  const usingCustom = (index: number) => (selected[index] ?? []).includes(OTHER);

  // Every question needs an answer, and a chosen "Other" needs its text —
  // submitting half an answer would resume the agent on a wrong premise.
  const canSubmit = request.questions.every((question, index) => {
    const choices = selected[index] ?? [];
    const forcedCustom = question.options.length === 0;
    if (forcedCustom || usingCustom(index)) return (custom[index] ?? '').trim().length > 0;
    return choices.length > 0;
  });

  const toggle = (index: number, value: string, multiSelect?: boolean) => {
    setSelected(current => {
      const choices = current[index] ?? [];
      if (!multiSelect) return { ...current, [index]: [value] };
      return {
        ...current,
        [index]: choices.includes(value)
          ? choices.filter(choice => choice !== value)
          : [...choices, value],
      };
    });
  };

  const submit = () => {
    if (!canSubmit || busy) return;
    onRespond({
      kind: 'question',
      answers: request.questions.map((question, index) => {
        const forcedCustom = question.options.length === 0;
        const chosen = (selected[index] ?? []).filter(value => value !== OTHER);
        const text = (custom[index] ?? '').trim();
        const values =
          forcedCustom || usingCustom(index) ? [...chosen, text] : chosen;
        return { questionIndex: index, values };
      }),
    });
  };

  return (
    <>
      {request.questions.map((question, index) => {
        const forcedCustom = question.options.length === 0;
        return (
          <fieldset key={index} className="ztk-interaction__question">
            <legend className="ztk-interaction__title">{question.question}</legend>
            {question.header && (
              <div className="ztk-interaction__description">{question.header}</div>
            )}
            {question.options.map(option => (
              <label key={option.value} className="ztk-interaction__option">
                <input
                  type={question.multiSelect ? 'checkbox' : 'radio'}
                  name={`ztk-q-${index}`}
                  checked={(selected[index] ?? []).includes(option.value)}
                  disabled={busy}
                  onChange={() => toggle(index, option.value, question.multiSelect)}
                />
                <span>
                  <span className="ztk-interaction__option-label">{option.label}</span>
                  {option.description && (
                    <span className="ztk-interaction__option-description">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            ))}
            {(question.allowCustomValue || forcedCustom) && (
              <>
                {!forcedCustom && (
                  <label className="ztk-interaction__option">
                    <input
                      type={question.multiSelect ? 'checkbox' : 'radio'}
                      name={`ztk-q-${index}`}
                      checked={usingCustom(index)}
                      disabled={busy}
                      onChange={() => toggle(index, OTHER, question.multiSelect)}
                    />
                    <span className="ztk-interaction__option-label">Other</span>
                  </label>
                )}
                {(forcedCustom || usingCustom(index)) && (
                  <input
                    type="text"
                    className="ztk-interaction__input"
                    aria-label={question.customValuePlaceholder ?? 'Your answer'}
                    placeholder={question.customValuePlaceholder ?? 'Your answer'}
                    value={custom[index] ?? ''}
                    disabled={busy}
                    onChange={event =>
                      setCustom(current => ({ ...current, [index]: event.target.value }))
                    }
                  />
                )}
              </>
            )}
          </fieldset>
        );
      })}
      <div className="ztk-interaction__actions">
        <button
          type="button"
          className="ztk-interaction__button ztk-interaction__button--primary"
          disabled={busy || !canSubmit}
          onClick={submit}
        >
          Submit
        </button>
      </div>
    </>
  );
}

// ── Form ────────────────────────────────────────────────────────

type FormValue = string | string[] | boolean;

function initialFormValues(fields: FormField[]): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const field of fields) {
    if (field.type === 'confirm') values[field.id] = field.defaultValue === 'true';
    else if (field.type === 'multiselect') values[field.id] = [];
    else values[field.id] = field.defaultValue ?? '';
  }
  return values;
}

function FormBody({
  request,
  onRespond,
  busy,
}: {
  request: FormRequest;
  onRespond: (response: InteractionResponse) => void;
  busy: boolean;
}) {
  const [values, setValues] = useState<Record<string, FormValue>>(() =>
    initialFormValues(request.fields),
  );
  const set = (id: string, value: FormValue) =>
    setValues(current => ({ ...current, [id]: value }));

  const canSubmit = request.fields.every(field => {
    if (!field.required) return true;
    const value = values[field.id];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'boolean') return true;
    return String(value ?? '').trim().length > 0;
  });

  return (
    <>
      <Header title={request.title} description={request.description} />
      {request.fields.map(field => (
        <div key={field.id} className="ztk-interaction__field">
          <label className="ztk-interaction__field-label" htmlFor={`ztk-f-${field.id}`}>
            {field.label}
            {field.required && <span aria-hidden="true"> *</span>}
          </label>
          {field.description && (
            <div className="ztk-interaction__description">{field.description}</div>
          )}
          <FieldControl
            field={field}
            value={values[field.id]}
            busy={busy}
            onChange={value => set(field.id, value)}
          />
        </div>
      ))}
      <div className="ztk-interaction__actions">
        <button
          type="button"
          className="ztk-interaction__button"
          disabled={busy}
          onClick={() => onRespond({ kind: 'form', values: {}, cancelled: true })}
        >
          {request.cancelLabel ?? 'Cancel'}
        </button>
        <button
          type="button"
          className="ztk-interaction__button ztk-interaction__button--primary"
          disabled={busy || !canSubmit}
          onClick={() => onRespond({ kind: 'form', values })}
        >
          {request.submitLabel ?? 'Submit'}
        </button>
      </div>
    </>
  );
}

function FieldControl({
  field,
  value,
  busy,
  onChange,
}: {
  field: FormField;
  value: FormValue | undefined;
  busy: boolean;
  onChange: (value: FormValue) => void;
}) {
  const id = `ztk-f-${field.id}`;
  switch (field.type) {
    case 'textarea':
      return (
        <textarea
          id={id}
          className="ztk-interaction__input"
          rows={4}
          value={String(value ?? '')}
          placeholder={field.placeholder}
          disabled={busy}
          onChange={event => onChange(event.target.value)}
        />
      );
    case 'confirm':
      return (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={busy}
          onChange={event => onChange(event.target.checked)}
        />
      );
    case 'number':
      return (
        <input
          id={id}
          type="number"
          className="ztk-interaction__input"
          value={String(value ?? '')}
          placeholder={field.placeholder}
          disabled={busy}
          onChange={event => onChange(event.target.value)}
        />
      );
    case 'select':
      return (
        <select
          id={id}
          className="ztk-interaction__input"
          value={String(value ?? '')}
          disabled={busy}
          onChange={event => onChange(event.target.value)}
        >
          <option value="">—</option>
          {(field.options ?? []).map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'multiselect': {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div id={id} className="ztk-interaction__checkboxes">
          {(field.options ?? []).map(option => (
            <label key={option.value} className="ztk-interaction__option">
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                disabled={busy}
                onChange={() =>
                  onChange(
                    selected.includes(option.value)
                      ? selected.filter(item => item !== option.value)
                      : [...selected, option.value],
                  )
                }
              />
              <span className="ztk-interaction__option-label">{option.label}</span>
            </label>
          ))}
        </div>
      );
    }
    default:
      return (
        <input
          id={id}
          type="text"
          className="ztk-interaction__input"
          value={String(value ?? '')}
          placeholder={field.placeholder}
          disabled={busy}
          onChange={event => onChange(event.target.value)}
        />
      );
  }
}

// ── Plan review ─────────────────────────────────────────────────

function PlanReviewBody({
  request,
  onRespond,
  busy,
}: {
  request: PlanReviewRequest;
  onRespond: (response: InteractionResponse) => void;
  busy: boolean;
}) {
  const [feedback, setFeedback] = useState('');
  const { renderMarkdown } = useTranscriptCapabilities();

  return (
    <>
      <Header title="Plan ready for review" />
      <div className="ztk-interaction__plan">
        {renderMarkdown?.(request.plan) ?? <div className="ztk-interaction__plain">{request.plan}</div>}
      </div>
      {request.todos && request.todos.length > 0 && (
        <ul className="ztk-interaction__todos">
          {request.todos.map((todo, index) => (
            <li key={index} data-status={todo.status}>
              {todo.content}
            </li>
          ))}
        </ul>
      )}
      <textarea
        className="ztk-interaction__input"
        aria-label="Feedback"
        placeholder="Feedback (optional)"
        rows={2}
        value={feedback}
        disabled={busy}
        onChange={event => setFeedback(event.target.value)}
      />
      <div className="ztk-interaction__actions">
        <button
          type="button"
          className="ztk-interaction__button"
          disabled={busy}
          onClick={() =>
            onRespond({
              kind: 'plan_review',
              decision: 'reject',
              ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
            })
          }
        >
          Request changes
        </button>
        <button
          type="button"
          className="ztk-interaction__button ztk-interaction__button--primary"
          disabled={busy}
          onClick={() =>
            onRespond({
              kind: 'plan_review',
              decision: 'approve',
              ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
            })
          }
        >
          Approve
        </button>
      </div>
    </>
  );
}

// ── Secret ──────────────────────────────────────────────────────

function SecretBody({
  request,
  onRespond,
  busy,
}: {
  request: SecretInputRequest;
  onRespond: (response: InteractionResponse) => void;
  busy: boolean;
}) {
  const [value, setValue] = useState('');
  const label =
    request.label ??
    (request.secretKind === 'password'
      ? 'Password'
      : request.envVar
        ? `Value for ${request.envVar}`
        : 'Secret');

  const submit = () => {
    if (!value || busy) return;
    onRespond({ kind: 'secret_input', value });
    // Dropped as soon as it is handed over: a secret should not sit in
    // component state waiting to be read by anything else.
    setValue('');
  };

  return (
    <>
      <Header title={label} />
      <input
        type="password"
        className="ztk-interaction__input"
        aria-label={label}
        autoComplete="off"
        value={value}
        disabled={busy}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') submit();
        }}
      />
      <div className="ztk-interaction__actions">
        <button
          type="button"
          className="ztk-interaction__button ztk-interaction__button--primary"
          disabled={busy || !value}
          onClick={submit}
        >
          Submit
        </button>
      </div>
    </>
  );
}
