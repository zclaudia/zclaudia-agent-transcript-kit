# Roadmap 与施工上下文

本文固化"换一台机器就会丢"的调研结论：三个 host 的 adapter 施工清单（关键
文件与耦合点）、layer-2 剩余项的参考实现位置、环境注意事项。调研时间
2026-08-21，行数为当时快照，动手前以实际代码为准。

## 总路线（决议见 README）

1. **intellij adapter**：用本包替换 vendored 的 `state.ts`/`protocol.ts`，终结漂移 ← 第一站
2. **layer-3 transcript 渲染件**：前置是 zclaudia 渲染件 store 依赖 props 化
3. **hermes 接入**：最后做，可只接 layer 1+2

## Host 1：intellij-idea-coding-agent-plugin（第一站，核心已完成 2026-08-23）

**已完成**（intellij 仓库分支 `transcript-kit-adapter`，计划文档
`docs/superpowers/plans/2026-08-23-transcript-kit-adapter.md`）：

- `agent-daemon` 以 npm 依赖 `^0.1.0` 接入  （首发 0.1.0 已上 npm，trusted publishing 已配）；边界脚本放行（agent-daemon 是 private 包）。
- 新增 `src/ui/transcript-adapter.ts`：`ProviderRuntimeEvent` → `TranscriptEvent`
  （assistant→snapshot、assistant_delta→delta、thinking（带 signature/redacted）、
  tool 生命周期含 legacy 无 toolUseId 的确定性生成 id）；init/mode_transition/
  provider_error 留 host。
- `state.ts` 重写：每 session 一个 kit `TranscriptState` 真源 + `projectSession()`
  投影出旧 `PlaygroundMessage`/`PlaygroundToolCall`（UI 零改动）；vendored 的
  `mergeAssistantContent` 内部/`appendBlock`/`upsertAssistant`/`applyRuntimeEvent`
  全部删除；`runErrors` overlay 承载 provider_error 与断线 reconcile 提示。
  采纳的 kit 语义变化：run_failed/aborted 取消 running tools（投影为 error）、
  重放 tool_started 严格幂等。
- `message-content.ts` 变为 kit `splitThinkTags` 之上的展示薄封装
  （kit 为此新增 `thinkingSegments`）；`MessageItem` 改用 kit
  `stabilizeStreamingMarkdown`。
- 195 个 daemon 测试全绿，vendored 契约测试断言零修改；typecheck×2、
  build:ui、边界脚本均过。

**后续阶段（已完成 2026-08-23，分支 `station1-followups`）**：

- `tool-presentation.ts`/`diff.tsx` 内部换 kit（`toolSummary`/`stripAnsi`/
  `asRecord`/`extractFilePath`/`diffLines`/`diffStats`）；host 只留展示策略
  （图标、chip、语言映射、更宽的 todo 匹配）。
- 消息泵合批：`message-pump.ts` 把流式 delta 按帧（rAF/16ms）合并为一次
  `server_batch` dispatch——**注意 intellij 没有用 kit 的
  `createTranscriptBatcher`**：其 wire→TranscriptEvent 翻译在 reducer 内部，
  合批只能上移一层到 server message 粒度（不合并内容，inspector 粒度保留）。
  kit batcher 适用于翻译在泵侧的 host（hermes/zclaudia）。
- 交互存储进 kit：wire 请求翻译为 kit `InteractionRequest`
  （permission→approval、question、plan_approval→plan_review、
  elicitation→form），wire 原对象走 `ext.wire`；`session.interactions` 变投影，
  host 的增删/turn 结束清理逻辑删除（kit endTurn 接管）。交互卡片 UI 本体
  仍消费 wire 对象——共享 InteractionCard 是 layer 3 的活。
- 全程 203 测试零断言修改；真机冒烟含审批卡 Allow 回路。

**Host 1 剩余**：无（layer-3 组件化后再回来换卡片）。

以下为原始调研记录：

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

## Host 2：zclaudia（核心已完成 2026-08-24）

**已完成**（zclaudia 仓库分支 `transcript-kit-runstore`）：

- `runStore` 改造：每个 run 一个单 turn 的 kit `TranscriptState`
  （`runTranscripts[runId]`，turnId=runId）；`runContentBlocks`/
  `activeToolCalls`/`toolCallsHistory` 全部变投影，action 名与签名不变，
  selector/`finalizeRunToMessage`/全部测试零改动。手写的尾部文本合并、
  tool 幂等、块顺序逻辑删除。host 保留：结果 first-wins 与 activity
  仅运行中的守卫（kit 是 latest-wins）、`ToolEffect` side-map
  （kit 愿望单：tool 事件加 `ext` 槽）。
- `delta-buffer` 换 kit `createTranscriptBatcher`：text delta 按帧合并
  不变；**tool_use 改走同一队列**（urgent 同步冲刷缓冲文本），修复了
  "delta 缓冲 + tool 块立即 append" 的同帧顺序倒置隐患（新增回归测试
  钉住顺序）。tool_result/tool_activity 不建块，保持直连。
- 4383 测试（unit/hooks/ui）通过，仅新增 1 条回归测试。

**Host 2 剩余**：`interaction_todo_update` → marker 降级（决议 #1，待
UI 有消费点再做）；断线对账（sessionSync/heartbeat-reconciliation）
按设计留 host；layer-3 前置的 props 化清单见下。

以下为原始调研记录：

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

## Host 3：hermes-client-mobile（核心已完成 2026-08-29）

**已完成**（hermes 仓库分支 `transcript-kit-adapter`）：

- `src/lib/transcript-adapter.ts`：gateway 事件 → `TranscriptEvent`。两处
  hermes 特有形状在 adapter 消化：`message.complete` 带的是整条消息 →
  映射为 `snapshot`（kit 与已到达的 delta 对账，丢尾也能补）；
  `thinking.delta`/`reasoning.delta` 是同一个流的两个名字。
  `resolveToolCallId` 让 host 决定事件属于哪个 tool call
  （老网关无 `tool_id`、generating 占位需被接管）。
- `src/lib/transcript-projection.ts`：kit 块结构 → hermes 扁平 `ChatEntry[]`。
  **验证了 roadmap 原来的断言**"扁平可无损投影"。entry id 由
  `turnId:blockIndex` 派生，turn 增长时不移位——否则流式过程中 React 重挂载
  行、读者丢滚动位置。
- `useStream` 改造：`entries` 变投影，`setEntries` 归零。host 保留 session
  路由、前后台、busy/activity、interrupt 记账、sending。
- **删除三个被取代的实现**：`parseCompletedTool`（→ kit `classifyTool`）、
  `findRunningToolIndex`（→ host resolver）、`applyReactionEvent`（→ 直接
  匹配 transcript items）。`stream-model.ts` 342 → 168 行。
- 两个 host 自造字段其实 kit 已能表达：`toolGenerating` = `running &&
  input === undefined`；`tool.progress` 是**替换**命令预览而非追加输出，
  对应 `tool_activity.summary` 而非 `outputDelta`（我一开始映射错了，
  读 host 代码才发现）。
- 测试 74 → 99。**先写 11 条表征测试**钉住 742 行无测试 hook 的行为，
  重构后一条未改地全绿；删除旧函数前把它们的覆盖移植到新实现。

**接入暴露的 kit 缺口（已补，0.4.0）**：provider 先报工具名、后补参数，
而 kit 的 `tool_started` 对已存在调用是严格 no-op → 参数丢失。改为
**只填补缺失字段**：重放仍是严格 no-op（渲染身份不变），部分事件不会
抹掉已知值。`name` 同时改为可选——它本来就可选，zclaudia 一直传空串
糊弄类型。

**Layer 3 接入（已完成 2026-08-29）——最后一个假设验证通过**：

hermes 与另外两个 host 在每一层都不同：纯 hex 而非 HSL 分量、
`[data-theme]` 属性而非 class、手写 CSS 而非 Tailwind、highlight.js
而非 Prism。映射依然只是一段 `var()` 引用——自定义属性在**使用时**
解析，一次映射覆盖两个主题。

验证暴露并修掉两个真问题：

1. **"高亮器可注入"原本只是名义上的**：kit 样式表只认 Prism 的
   `token keyword`，highlight.js 输出 `hljs-keyword` → 接上去只有结构
   没有颜色。kit 0.5.0 让样式表同时映射两套词汇到同一组语义变量。
   **这个缺陷只有第三个 host 能发现**（前两个都用 Prism）。
2. **hermes 的代码高亮本来就是坏的**：引的是
   `highlight.js/styles/github.css`——钉死的 light 配色，dark 模式下
   读者看到浅色主题的语法色。接 kit 后语法色走 `--ztk-code-*`，每个
   主题一套。顺带查了对比度：light 的注释色（GitHub `#6e7781`）在
   hermes 略深的代码底色上只有 4.0:1，调深到 `#656d76`；两个主题最差
   项现为 4.63:1 / 4.95:1，均过 AA。

**Host 3 剩余**：UI 层的移动端手势不强求接；ThinkingBlock/ToolCallCard
可按需接（hermes 的 thinking/tool 是整行 entry，结构与卡片不同）。

以下为原始调研记录：

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

## Layer 2 剩余项（已全部完成，2026-08-22）

| 已做 | kit 位置 | 参考实现 |
| --- | --- | --- |
| delta 合批（rAF/时间窗，framework 无关） | `src/delta-batch.ts`（`createTranscriptBatcher`：scheduler 可注入，默认 rAF → setTimeout(16) 回退；相邻同 turn 的 text/thinking delta 与同 tool 的 activity 合并；生命周期事件同步冲刷保证 finalize 前状态齐全） | intellij `agent-daemon/src/ui/transport.ts`（16ms 批窗口）；zclaudia `services/message-handlers/delta-buffer.ts`（rAF 合批）；hermes 无（受益方） |
| tool 分类器（name+input+result → `ToolPresentation`） | `src/tool-classify.ts`（`classifyTool`/`toolSummary` 等；工具名同时覆盖 Claude 系与 pi-agent 系；带 hermes 式结果截断上限） | hermes `lib/stream-model.ts` 的 `parseCompletedTool()`；intellij `ui/transcript/tool-presentation.ts`；zclaudia `tool-call/toolClassifiers.ts` + `toolFormatters.ts` |
| diff 工具（解析/逐行着色/上限） | `src/diff.ts`（`diffLines` LCS + 400 行上限降级、`parseUnifiedDiff`（先剥 ANSI）、`diffStats`、`extractUnifiedDiffPath`）；`stripAnsi` 进了 `src/text-utils.ts` | hermes `components/DiffLines.tsx`；intellij `ui/transcript/diff.tsx`；zclaudia `components/renderers/DiffViewer.tsx` |

注：intellij 图标映射（lucide `toolIcon()`）与代码高亮语言映射（`languageForPath`）
是 UI 关注点，留给 layer 3 / host。

## Layer 3 前置：zclaudia props 化（已完成 2026-08-25）

四刀做完，两个渲染件（`ToolCallCard`、`CodeBlock`）host 依赖归零（含类型），
可直接搬进 kit：

1. **ToolCallItem 拆分**：纯 `ToolCallCard`（头部/状态/展开/工具体）+ connected
   `ToolCallItem`（session/交互 store 查找、能力装配）。能力走 props：
   `onSendToBackground` / `runInTerminal`，存在即渲染入口。
   埋在按钮里的 5 个全局依赖上移为 host 钩子 `useRunInTerminal()`
   （无远程终端时返回 undefined）。
2. **MessageList 能力收拢**：新增 `TranscriptCapabilities` context——**渲染件
   自己的** context（定义权随组件走，区别于 host 的 ConnectionContext /
   ThemeContext）；代码块深埋 markdown 映射、props 传不进，context 是唯一路径。
   `CodeBlock` 独立成文件并消费它，其中**第二份逐字重复的终端粘贴逻辑被删除**。
   MessageList 保留容器级 store（filePushStore）——列表本身不是抽取目标。
3. **主题 token 化**：唯一残留的非 token 主题依赖是代码高亮的
   `oneDark`/`oneLight` JS style 对象（5 个主题只有 2 套配色，且绑死
   react-syntax-highlighter）。改为每主题 14 个 `--code-*` token（锚定既有
   hue 轴；bg/comment/punctuation 跟随各主题 hue 轴）+ `.zc-code` 规则映射
   Prism 标准 token 类，`useInlineStyles={false}`。**颜色契约共享、高亮实现
   由 host 选**——hermes 的 highlight.js 也能对齐同一套变量。
   副作用：CodeBlock 不再需要任何主题输入，`isDarkCode` 退出能力接口。
4. **类型换 kit**：`ToolCallCard` 改吃 `ToolCallView`；`toolCallView.ts` 做
   host→kit 适配（实时 store 与持久化 `message.toolCalls` 同形状，共用一个
   适配器；`ToolEffect` 走 kit 的 `ext` 开放槽）；转换在 connected wrapper 内
   memo 化。classifier/formatter 改吃 kit 的**开放** `ToolSemantic`。
   既有测试抓到一个真 bug：`isError` 是独立字段，持久化行可能是
   `completed + isError`，映射必须让它压过 status（已加回归测试）。

**纯度契约有哨兵测试**：`ToolCallCard.test.tsx` / `CodeBlock.test.tsx` 零
store/context mock 渲染——组件还能不能抽走，跑这两个文件就知道。

**layer 3 开工前剩余**：`MessageList` 里的 `ThinkingBlock` / `SegmentedContent`
等仍内联在容器文件里（未拆分，但已无 host 依赖）；`InteractionItem` 未动
（等 kit 的 InteractionCard 设计）。

## Layer 3（进行中，2026-08-26 起）

**已完成**：
- kit 加 `/react` 子路径入口（core 保持零依赖、React 为可选 peer）、
  `transcript.css` 资产、`scripts/copy-assets.mjs`。
- `TranscriptCapabilities`（能力 context，kit 定义）+ 首个组件 `CodeBlock`。
- 三条架构决议（见 README）：**入口分离**、**零第三方运行时依赖**
  （高亮器由 host 注入、图标内联 SVG）、**`--ztk-*` CSS 变量做主题接口**
  （不用 Tailwind 工具类——那会要求每个消费者的 Tailwind 扫描本包，
  且 hermes 手写 CSS）。
- zclaudia 已消费：`CodeBlock`/能力 context 全部来自 kit，host 只留
  Prism 注入器 + 一次性 token 映射（5 个主题全跟随）。2808 UI 测试通过，
  含新增的高亮器契约测试（单一 `<pre>`、token class 而非内联样式）。

**已搬组件**：`CodeBlock`、`ToolCallCard`、`ThinkingBlock`。

- `ToolCallCard`：卡片壳 + 状态 + 折叠 + plan 自动展开进 kit；**图标**走
  新增的 `toolIcon` capability，**展开体**走 `renderExpanded` render prop
  （diff/终端/图片/插件渲染器是 host 的）。卡片发布 `data-status`
  （running/done/error）作为公开契约——host 样式和测试都钉它，kit 内部
  类名可自由重构。顺带把 MCP 命名约定（`isAskUserFormTool` 等）、
  `toolDisplayName`、增强版 `toolSummary` 收进 `tool-classify`。
- `ThinkingBlock`：两个 host 变体（`<thinking>` 文本 / 结构化 blocks）
  合成一个，`content` 接受 `string | ThinkingSegment[]`；计数标签按形态
  分别显示 lines/blocks。

**已搬组件（0.3.0 已发布，两个 host 均以 `^0.3.0` 消费）**：
`CodeBlock`、`ToolCallCard`、`ThinkingBlock`、`DiffView`。

**跨 host 复用已验证（2026-08-28）**：intellij 接入 `ToolCallCard`/
`ThinkingBlock`/`DiffView`，同一份组件在两套 token 体系下各自正确渲染
（diff 在 intellij 是 11px、zclaudia 12px，字体/图标各自跟随）。

- **卡片布局已统一**：intellij 原为 `[chevron][icon][name][summary][status]`，
  现统一为 kit 的 `[status][icon][name][summary][chevron]`——两种排列表达
  同一件事，与其给 kit 加 per-host 开关，不如让 transcript 收敛
  （intellij UI 本就 vendored from zclaudia）。
- intellij 的展开体（diff/终端/高亮源码/todo）与 "Open in IDE" 走
  `renderExpanded`；lucide 图标走 `toolIcon` capability。
- 从 intellij 吸收进 kit：plan proposal 按语义命名为 "Plan proposal"
  （工具名 `ExitPlanMode` 说的是机制）。删掉了 intellij 的死 prop
  `defaultExpanded`（无调用点），kit 因此不必新增该 API。
- **intellij 暂不接 `CodeBlock`**：它没有 `--code-*` 语法色 token
  （高亮走 Prism 内置主题），接入等于把配色迁到 kit 默认色，是独立决策。

**待办**：InteractionCard（需先定 kit `InteractionRequest` 四 kind 的响应
契约）；intellij 的 CodeBlock 配色迁移；kit 自身的组件测试（现由两个 host
的测试代跑）。

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
- 远程仓库：`git@github.com:zclaudia/zclaudia-agent-transcript-kit.git`。
- hermes 编译依赖 `~/.hermes/hermes-agent` checkout（见 Host 3）。
- 三个 host 仓库均在原机器 `~/Code/` 下；zclaudia 的 gateway 在其同级目录
  `../zclaudia-gateway/`。
