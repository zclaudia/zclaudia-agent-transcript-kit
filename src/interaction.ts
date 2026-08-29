/**
 * Unified blocking-interaction model.
 *
 * Sources being unified:
 *  - hermes     clarify / approval / sudo / secret        (usePrompts.ts)
 *  - intellij   permission / question / plan_approval / elicitation (protocol.ts)
 *  - zclaudia   interaction_prompt (question|form) / interaction_approval /
 *               plan_review / interaction_todo_update      (interaction/forms.ts)
 *
 * Todo updates are deliberately NOT here: they are non-blocking notices and
 * map to ToolPresentation{kind:'todo'} or a MarkerItem instead.
 */

import type { Ext, TodoItemView } from './transcript.js';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface InteractionBase {
  id: string;
  /** Turn the interaction belongs to, when the host can attribute it. */
  turnId?: string;
  createdAt?: number;
  ext?: Ext;
}

export type InteractionRequest =
  | ApprovalRequest
  | QuestionRequest
  | FormRequest
  | PlanReviewRequest
  | SecretInputRequest;

/**
 * Permission to run something (a command, a tool, an escalation).
 *
 * Capability-declaration model: the request declares which extras the host
 * can honor (`allowedScopes`, `editableInput`, timeout fields); the shared
 * card renders only declared capabilities, and adapters ignore response
 * fields for capabilities they did not declare.
 */
export interface ApprovalRequest extends InteractionBase {
  kind: 'approval';
  title?: string;
  description?: string;
  /** The command / tool input being approved, when applicable. */
  command?: string;
  toolName?: string;
  toolInput?: unknown;
  /**
   * Scopes the host supports beyond a plain once-allow.
   * hermes: ['once','session','always'] (allow_permanent gates 'always');
   * plugin-sdk hosts omit this (no scope concept).
   */
  allowedScopes?: ApprovalScope[];
  /** Host supports allow-with-modified-input (PermissionDecision.updatedInput). */
  editableInput?: boolean;
  /** Countdown display; resolution on expiry arrives as interaction_resolved{timeout}. */
  timeoutSeconds?: number;
  /** What the host does when the timeout fires. Default: deny. */
  timeoutBehavior?: 'approve' | 'deny';
  approveLabel?: string;
  rejectLabel?: string;
}

export type ApprovalScope = 'once' | 'session' | 'always';

/** One or more multiple-choice questions (AskUserQuestion shape). */
export interface QuestionRequest extends InteractionBase {
  kind: 'question';
  questions: QuestionView[];
}

export interface QuestionView {
  question: string;
  /** Short chip label when the host provides one. */
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  /** Free-text answer allowed ("Other"). hermes clarify with no choices => options: [], allowCustomValue: true. */
  allowCustomValue?: boolean;
  customValuePlaceholder?: string;
}

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

/** Structured form (MCP elicitation / zclaudia form variant). */
export interface FormRequest extends InteractionBase {
  kind: 'form';
  title: string;
  description?: string;
  fields: FormField[];
  submitLabel?: string;
  cancelLabel?: string;
}

export interface FormField {
  id: string;
  label: string;
  description?: string;
  type: 'text' | 'textarea' | 'select' | 'multiselect' | 'confirm' | 'number';
  options?: QuestionOption[];
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
  allowCustomValue?: boolean;
}

/** Review of a proposed plan before execution. */
export interface PlanReviewRequest extends InteractionBase {
  kind: 'plan_review';
  /** Markdown plan body. */
  plan: string;
  todos?: TodoItemView[];
}

/**
 * Sensitive value entry (hermes sudo password / secret env var).
 * Responses must never be persisted or echoed into the transcript.
 */
export interface SecretInputRequest extends InteractionBase {
  kind: 'secret_input';
  secretKind: 'password' | 'env_var' | 'other';
  label?: string;
  /** For env_var: the variable being requested. */
  envVar?: string;
}

// ---------------------------------------------------------------------------
// Responses & resolution
// ---------------------------------------------------------------------------

export type InteractionResponse =
  | {
      kind: 'approval';
      decision: 'allow' | 'deny';
      /** Only meaningful when the request declared allowedScopes. */
      scope?: ApprovalScope;
      /** Only meaningful when the request declared editableInput. */
      updatedInput?: unknown;
      /** Deny reason, relayed to the agent when the host supports it. */
      message?: string;
    }
  | { kind: 'question'; answers: QuestionAnswer[] }
  | {
      kind: 'form';
      values: Record<string, string | string[] | boolean>;
      /**
       * The user dismissed the form instead of filling it in. Distinct from
       * submitting an empty one: hosts relay these to the agent differently
       * (accept with no values vs. decline), and `values` alone cannot tell
       * them apart.
       */
      cancelled?: boolean;
    }
  | { kind: 'plan_review'; decision: 'approve' | 'reject'; feedback?: string }
  | { kind: 'secret_input'; value: string };

export interface QuestionAnswer {
  /** Index into QuestionRequest.questions. */
  questionIndex: number;
  /** Selected option values and/or the custom free-text value. */
  values: string[];
}

/** Why an interaction went away without a user response. */
export type InteractionResolvedReason =
  | 'answered'
  | 'timeout'
  | 'cancelled'
  | 'superseded'
  | 'stale';
