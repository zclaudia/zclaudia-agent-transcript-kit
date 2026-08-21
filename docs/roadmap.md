# Roadmap 与施工上下文

本文固化"换一台机器就会丢"的调研结论：三个 host 的 adapter 施工清单（关键
文件与耦合点）、layer-2 剩余项的参考实现位置、环境注意事项。调研时间
2026-08-21，行数为当时快照，动手前以实际代码为准。

## 总路线（决议见 README）

1. **intellij adapter**：用本包替换 vendored 的 `state.ts`/`protocol.ts`，终结漂移 ← 第一站
2. **layer-3 transcript 渲染件**：前置是 zclaudia 渲染件 store 依赖 props 化
3. **hermes 接入**：最后做，可只接 layer 1+2

## Host 1：intellij-idea-coding-agent-plugin（第一站）

仓库：pnpm monorepo；UI 是 JCEF 里的 React 应用，住在 `packages/agent-daemon/`。

**vendoring 现状**：18 个文件带 `// vendored from zclaudia:apps/desktop/... @ 746cd662`
标记（含 `src/ui/AgentPlaygroundApp.tsx`（3850 行单体）、`src/protocol.ts`、
`src/ui/styles/index.css`、`tailwind.config.js`）。`grep -rl "vendored from zclaudia"`
可拿到完整清单。本包落地后这些标记应逐步消失。

**要替换的**：
- `src/ui/state.ts`（724 行）：`AssistantBlock`/`PlaygroundMessage`/`PlaygroundToolCall`
  与 `applyRuntimeEvent()`（223–320 行附近）、`mergeAssistantContent()` →
  kit 的 reducer + `mergeStreamText`。adapter 本体 ≈ 把 `ProviderRuntimeEvent`
  （来自 `@zclaudia/plugin-sdk/providers`）翻译成 `TranscriptEvent`：
  `assistant/assistant_delta` → `text_delta{delta|snapshot}`（snapshot 消化
  legacy provider 终态全量），`tool_started/finished`、`thinking_delta`、
  `provider_turn_finished` → `turn_finished`、`mode_transition`/`retry_scheduled`
  → `marker`。
- `src/protocol.ts`（620 行）交互部分：`AgentPlaygroundInteractionRequest`
  （`PermissionRequest & {interaction: permission|question|plan_approval|elicitation}`）
  → kit 的 `InteractionRequest` 四种 kind。

**留在 host 的**：session tab 管理、`runSessionIds` 路由、WS `sequence` 去重
（`transport.ts`）、`events[]` inspector 缓冲、持久化（`PersistedMessage` 只存
文本 → 用 `turnText()` 生成）。`protocol.ts` 里约 40% 的 `IdeContext*` 类型
是 IDE 专有数据，走 `UserMessageItem.ext`。

**注意**：仓库有 `scripts/check-package-boundaries.mjs` 强制包边界（publishable
包不得 workspace 依赖、不得 import `@zclaudia/shared`）；引入本包时确认规则放行。

## Host 2：zclaudia

**adapter（client 侧）**：`apps/desktop/src/services/messageHandler.ts`（307 行，
`ServerMessage` 分发入口）与 `services/message-handlers/run-messages.ts`（392 行，
run 生命周期）是被翻译对象——wire 的 `delta`/`tool_use`/`tool_result`/`tool_activity`/
`run_completed`/`run_failed` → `TranscriptEvent`。`interaction_todo_update` 按决议
降级为 `marker{markerType:'todo_update'}`。断线对账（`sessionSync.ts` 437 行、
`heartbeat-reconciliation.ts` 402 行）留在 host。

**老数据规则**：持久化行没有 `metadata.contentBlocks` 的（老库），adapter 把
`content` 包成单个 text 块。

**layer-3 前置（props 化工作清单）**——渲染件当前直接 import 的全局依赖：
- `features/chat/MessageList.tsx`（1326 行）：`useFilePushStore`、`useTerminalStore`、
  `useProjectStore`、`useServerStore`
- `features/chat/ToolCallItem.tsx`：`useSelectionStore`、`useInteractionStore`、
  `usePromptRequestStore`
- Context：`ConnectionContext`（发送能力）、`ThemeContext`（代码高亮主题）、
  `ChatActionsContext`、`FileRefContext`
- UI 实际消费的 `MessageWithToolCalls`/`ToolCallState` 定义在 store 层
  （`chatMessageStore`/`runStore`），不在 shared —— 迁移时由 kit 类型取代
- 扩展点范式：`services/toolRendererRegistry.ts`（插件注册自定义 tool 渲染器）
  ——kit 的 marker/tool renderer registry 沿用此模式

**server 侧不动**：pi-agent → `ProviderRuntimeEvent` → domain event →
`wire-projector.ts` 的管线（见 zclaudia `docs/runtime-events.md`）是 wire 生产方，
与 kit 无关。

## Host 3：hermes-client-mobile（最后）

**wire**：自研 JSON-RPC over WebSocket，类型在外部包 `@hermes/shared`——
vite alias + tsconfig paths 指向 `~/.hermes/hermes-agent/apps/shared/src`。
**环境陷阱：机器上没有这个 checkout 时 hermes 无法编译。**

**adapter 素材**（都在 `src/`）：
- `lib/stream-model.ts`（342 行）：`routeGatewayEvent()`（session 归属推断，
  **留在 host**、跑在 adapter 之前）、`findRunningToolIndex()`（tool_id + 名字
  回退匹配 → 进 adapter）、`parseCompletedTool()`（terminal/file/image/search/
  generic 分类 → 几乎原样变成 presentation builder）
- `hooks/useStream.ts`（742 行）：事件订阅与归并——被 kit reducer 取代的主体；
  事件清单：`message.start/delta/complete`、`thinking.delta`、`reasoning.delta/
  available`、`tool.generating/start/progress/complete`、`status.update`
  （compacting → marker）、`error`
- `hooks/usePrompts.ts`（284 行）：clarify/approval/sudo/secret →
  `question`/`approval`/`secret_input`；`*.expire` → `interaction_resolved{timeout}`；
  `terminal.read.request` 自动空回复是纯 host 行为
- `hooks/useChat.ts`（477 行）：动作层（send/interrupt/branch/regenerate/react），
  留在 host

**耦合警告**：以上 hooks 全部硬 import `lib/gateway.ts` 的 `gw` 单例（无 DI/
Context）。adapter 化 = 把"gw 事件 → TranscriptEvent"抽成独立模块，reducer 状态
接进现有组件。reactions/`rowId`/`userOrdinal` 走 `ext`。

**顺带收益**：hermes 现在每个 delta 直接 `setEntries` 全量重建、无合批——接入
kit + delta 合批工具后白得性能优化。UI 层（手写 CSS、移动端手势）不强求接
layer 3。

## Layer 2 剩余项（参考实现位置）

| 待做 | 参考实现 |
| --- | --- |
| delta 合批（rAF/时间窗，framework 无关） | intellij `agent-daemon/src/ui/transport.ts`（16ms 批窗口）；zclaudia `services/message-handlers/delta-buffer.ts`（rAF 合批）；hermes 无（受益方） |
| tool 分类器（name+input+result → `ToolPresentation`） | hermes `lib/stream-model.ts` 的 `parseCompletedTool()`；intellij `ui/transcript/tool-presentation.ts`（242 行，图标/摘要/路径提取/ANSI 剥离）；zclaudia `tool-call/toolClassifiers.ts`（94）+ `toolFormatters.ts`（218） |
| diff 工具（解析/逐行着色/上限） | hermes `components/DiffLines.tsx`（27，ANSI 剥离）；intellij `ui/transcript/diff.tsx`（94，`diffLines()` + 400 行上限）；zclaudia `components/renderers/DiffViewer.tsx`（195） |

## Layer 3 备忘

- 只抽 transcript 渲染件：Markdown/CodeBlock、ToolCallCard、ThinkingBlock、
  DiffView、InteractionCard。**不抽**列表容器/虚拟化/滚动/composer（三家平台
  差异最大且各有存在理由：hermes 移动端长按手势、zclaudia 自研虚拟化、
  intellij scroll 管理）。
- 主题接口用 CSS 变量 token（两家 Tailwind + 一家手写 CSS 的最大公约数）。
- markdown 渲染三家均为 react-markdown + remark-gfm；代码高亮 intellij/zclaudia
  用 react-syntax-highlighter(Prism)、hermes 用 highlight.js——组件库选型时二选一。

## 环境备忘

- 本包自包含：`pnpm install && pnpm test` 即可，无其他前置。
- 本包尚无远程仓库；跨机器前先 push。
- hermes 编译依赖 `~/.hermes/hermes-agent` checkout（见 Host 3）。
- 三个 host 仓库均在原机器 `~/Code/` 下；zclaudia 的 gateway 在其同级目录
  `../zclaudia-gateway/`。
