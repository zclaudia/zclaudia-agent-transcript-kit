# @zclaudia/agent-transcript-kit

Shared agent-transcript view model, headless reducer, transcript utilities, and optional React
renderers for ZClaudia agent clients.

The kit unifies the rendering view model, not the wire protocol: each host application keeps its
own transport and writes a thin adapter that translates wire events into normalized
`TranscriptEvent`s. The shared reducer folds those into a block-structured transcript (text →
tool → text interleaving preserved), and pure selectors derive the strings hosts persist or copy.
Session routing, sequence dedup, and reconnect reconciliation stay host-side; the package has no
runtime dependencies and imports no host types. The React renderers are opt-in through a subpath,
so layer-1/2 consumers never acquire React.

## Install

```bash
pnpm add @zclaudia/agent-transcript-kit
```

## Usage

Feed adapter-translated events through the reducer and read the result with selectors:

```ts
import {
  applyTranscriptEvent,
  initialTranscriptState,
  orderedToolCalls,
  turnText,
  type TranscriptEvent,
} from '@zclaudia/agent-transcript-kit';

const events: TranscriptEvent[] = [
  { type: 'turn_started', turnId: 'run-1' },
  { type: 'text_delta', turnId: 'run-1', delta: 'Running the tests.' },
  {
    type: 'tool_started',
    turnId: 'run-1',
    toolCallId: 't1',
    name: 'Bash',
    input: { command: 'npm test' },
  },
  {
    type: 'tool_finished',
    turnId: 'run-1',
    toolCallId: 't1',
    presentation: { kind: 'terminal', command: 'npm test', output: '1 passing' },
  },
  { type: 'turn_finished', turnId: 'run-1' },
];

const state = events.reduce(
  (current, event) => applyTranscriptEvent(current, event, { assertEvents: true }),
  initialTranscriptState
);

const turn = state.items.find(item => item.kind === 'assistant_turn');
// turnText(turn) → 'Running the tests.'
// orderedToolCalls(turn)[0].presentation?.kind → 'terminal'
```

The reducer is immutable and framework-free; wrap it in `useReducer`, Zustand, or anything else.
Replays are idempotent — a repeated `turn_started`, `tool_started`, or `marker` changes nothing,
and text snapshots merge without duplicating — and stream events for an unknown turn create it, so
reconnecting mid-stream still renders.

Details of a tool call may arrive after the call itself: providers commonly announce a tool before
its arguments finish generating. A later `tool_started` for the same id fills in what is missing
(`name`, `input`, `semantic`) and touches nothing else, which is why replay stays a no-op and a
partial event cannot blank what is already known.

## Modules

- `transcript` — view model: `TranscriptItem`, `AssistantTurnItem`, `ToolCallView`,
  `ToolPresentation` (render by presentation, never by tool name), open `ext` slots.
- `interaction` — blocking interaction requests (approval/question/form/plan/secret) with
  capability-declared decision spaces.
- `events` — the adapter contract: normalized streaming `TranscriptEvent`s with `delta | snapshot`
  text semantics.
- `state` / `selectors` — the reducer plus `turnText`, `turnThinking`, `orderedToolCalls`,
  `activeTurn`, `pendingInteraction`.
- `delta-batch` — `createTranscriptBatcher`: coalesce streaming deltas into one commit per
  animation frame (16 ms fallback off-browser); lifecycle events flush synchronously.
- `tool-classify` — `classifyTool`/`toolSummary`: best-effort `name + input + result →
  ToolPresentation` for hosts without wire-level knowledge.
- `diff` — LCS line diff with a 400-line cap, unified-diff parsing, ANSI stripping.
- `text-utils` — `mergeStreamText`, `splitThinkTags`, `stabilizeStreamingMarkdown`, `stripAnsi`.
- `react` (subpath) — transcript renderers; see **React renderers** below.
- `guards` — dev-only `assertTranscriptEvent` (enable via `applyTranscriptEvent`'s
  `assertEvents`; skip in production builds).

## React renderers

Transcript components live behind a subpath so that consumers of layers 1–2
never acquire a React dependency:

```tsx
import {
  CodeBlock,
  ThinkingBlock,
  ToolCallCard,
  TranscriptCapabilitiesProvider,
} from '@zclaudia/agent-transcript-kit/react';
import '@zclaudia/agent-transcript-kit/transcript.css';

<TranscriptCapabilitiesProvider value={{ runInTerminal, highlightCode, toolIcon }}>
  <CodeBlock language="bash">npm test</CodeBlock>
  <ThinkingBlock content={reasoning} />
  <ToolCallCard toolCall={call} renderExpanded={() => <MyToolBody call={call} />} />
</TranscriptCapabilitiesProvider>;
```

- `CodeBlock` — fenced code with copy and, where the host offers a terminal,
  run-in-terminal.
- `ThinkingBlock` — collapsed reasoning; `content` takes either a string or the
  structured segments a provider streamed.
- `ToolCallCard` — a tool call's status, name, summary, and collapse behavior.
  The expanded body is the host's, passed as `renderExpanded` so it is built
  only when open; the card publishes its state as `data-status`
  (`running` / `done` / `error`) for host styling and tests.
- `DiffView` — a file change, from two revisions or a diff already rendered.
- `InteractionCard` — a blocking request for the reader's decision (approval,
  question, form, plan review, secret). Takes an `InteractionRequest` and calls
  `onRespond` with the matching `InteractionResponse`; delivering it is the
  host's job, and `busy` locks the controls while that is in flight.

  Capabilities are declared per request, not assumed: an approval offers only
  the scopes the host listed, allows editing the tool input only when the host
  can honor an edit, and states what the timeout will do only when the host
  will act on it. The card also refuses to submit an incomplete answer — an
  unanswered question or a chosen "Other" with no text — since a half-answer
  resumes the agent on a premise the reader never gave.

The renderers carry no runtime dependencies of their own. What differs between
hosts is injected through `TranscriptCapabilities`, and every field is optional
— an absent capability removes the affordance rather than breaking the render:

- `runInTerminal(command)` — enables "Run in terminal" on shell code blocks.
- `toolIcon(toolName)` — the host's icon for a tool. Icon sets and their
  components stay host-side; the kit renders what comes back and falls back to
  a generic glyph.
- `renderMarkdown(text)` — the host's markdown renderer, used for a plan under
  review. Same reasoning as the highlighter: hosts have one configured with
  their own plugins and link handling. Without it the text renders as written.
- `highlightCode(code, language)` — the host's syntax highlighter. The kit
  ships none because hosts disagree (Prism, highlight.js, none), and bundling
  one would duplicate what a host already has. Return inline content with
  token classes rather than inline styles, so the theme colors them: both
  Prism's (`token keyword`) and highlight.js's (`hljs-keyword`) vocabularies
  are styled. The kit owns the `<pre><code>` wrapper, so do not nest one.

### Theming

`transcript.css` defines the renderers' looks in terms of `--ztk-*` custom
properties and ships a neutral dark default. A host themes every renderer by
mapping its own tokens onto that contract once, on any ancestor:

```css
:root {
  --ztk-code-max-height: 20rem; /* long code scrolls instead of growing */
  --ztk-bg-subtle: hsl(var(--secondary));
  --ztk-border: hsl(var(--border));
  --ztk-code-bg: hsl(var(--code-bg));
  --ztk-code-keyword: hsl(var(--code-keyword));
  /* … */
}
```

Custom properties rather than utility classes: utilities would require every
consumer's Tailwind build to scan this package, and not every host uses
Tailwind. Because the mapping resolves at use time, a host with several themes
gets all of them from one mapping.

## Package boundaries

- The kit owns the transcript view model and the headless logic over it.
- Host applications own their wire protocols and the adapters that translate them; adapters never
  live in this package.
- The kit depends on nothing at runtime and must not import host ecosystem types.

Internal design notes live in [docs/design.md](docs/design.md), the cross-host mapping validation
in [docs/mapping.md](docs/mapping.md), and per-host adapter worklists in
[docs/roadmap.md](docs/roadmap.md).

## Tests

Two suites, each using what fits what it covers:

```bash
pnpm test        # both
pnpm test:core   # layers 1–2, on plain node
pnpm test:react  # renderers, under jsdom
```

`tests/run.ts` runs the reducer, selectors, and utilities on plain node with no
test framework at all. The package has no runtime dependencies, and testing it
that way keeps proving so — if an import crept in, this suite would stop
running. The renderers need a DOM, so they use vitest and Testing Library
(dev-only; neither reaches consumers).

## Compatibility

The package follows semantic versioning. Additive fields and events are minor changes. Removing or
changing a public field, event, or reducer behavior hosts can observe is a major change.

## Releasing

Publishing uses npm Trusted Publishing from `.github/workflows/publish.yml`; the repository does
not need an `NPM_TOKEN`. To release a version:

1. Update `package.json` to the new version and merge the change to `main`.
2. Create a `v<version>` tag, such as `v0.1.1`, on that commit.
3. Publish a GitHub Release for the tag.

The release workflow verifies that the tag matches `package.json`, runs all checks, and publishes
the public package through GitHub OIDC. Re-running a release for an already-published npm version
will fail because npm package versions are immutable.

## License

MIT
