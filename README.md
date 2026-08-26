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
Replays are idempotent (duplicate `turn_started`/`tool_started`/`marker` events are no-ops, text
snapshots merge without duplicating), and stream events for an unknown turn create it, so
reconnecting mid-stream still renders.

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
import { CodeBlock, TranscriptCapabilitiesProvider } from '@zclaudia/agent-transcript-kit/react';
import '@zclaudia/agent-transcript-kit/transcript.css';

<TranscriptCapabilitiesProvider value={{ runInTerminal, highlightCode }}>
  <CodeBlock language="bash">npm test</CodeBlock>
</TranscriptCapabilitiesProvider>;
```

The renderers carry no runtime dependencies of their own. What differs between
hosts is injected through `TranscriptCapabilities`, and every field is optional
— an absent capability removes the affordance rather than breaking the render:

- `runInTerminal(command)` — enables "Run in terminal" on shell code blocks.
- `highlightCode(code, language)` — the host's syntax highlighter. The kit
  ships none because hosts disagree (Prism, highlight.js, none), and bundling
  one would duplicate what a host already has. Return inline content with
  Prism-style token classes (`token keyword`, …); the kit owns the
  `<pre><code>` wrapper, so do not nest one, and emit classes rather than
  inline styles so the theme can color them.

### Theming

`transcript.css` defines the renderers' looks in terms of `--ztk-*` custom
properties and ships a neutral dark default. A host themes every renderer by
mapping its own tokens onto that contract once, on any ancestor:

```css
:root {
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
