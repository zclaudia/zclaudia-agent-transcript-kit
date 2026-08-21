# 映射验证：三个项目 → 共享视图模型

逐项目验证现有模型能否无损（或可接受地有损）映射到 `src/` 里的草稿类型。

## 1. zclaudia（最接近，基本 1:1）

| 现有（shared/src） | 草稿 | 说明 |
| --- | --- | --- |
| `Message{role:'user'}` + `metadata.attachments` | `UserMessageItem` | `MessageAttachment.fileId` → `AttachmentRef.ref`（host 解析成 URL） |
| `Message{role:'assistant'}` + `metadata.contentBlocks` | `AssistantTurnItem.blocks` | `ContentBlock` 三个 variant 与 `TurnBlock` 一一对应；`tool_use.toolUseId` → `tool_call.toolCallId` |
| `metadata.toolCalls: ToolCall[]` | `toolCalls: Record<id, ToolCallView>` | `ToolCall.effect`（file_change/shell）→ `ToolPresentation`（file_edit/terminal）；`isError` → `status:'error'` |
| `ThinkingBlock{text,signature,redacted}` | `TurnBlock{kind:'thinking'}` | 字段齐全 |
| `ToolSemantic`（plan_proposal/enter/exit） | `ToolSemantic` | 开放 string union，向前兼容 |
| `metadata.usage: UsageInfo` | `UsageSummary` | `cost.total` → `costUsd`；`contextUsedTokens` 保留 |
| `metadata.compactionMarker` / `contextUsage` | `MarkerItem{markerType:'compaction'\|'context_usage'}` | payload 原样透传，renderer registry 按 markerType 渲染（对齐现有 `toolRendererRegistry` 模式） |
| `metadata.steered` | `UserMessageItem.steered` | |
| wire `delta`/`tool_use`/`tool_result`/`run_completed`… | `TranscriptEvent` | adapter ≈ 现有 `services/message-handlers/run-messages.ts` 的子集 |
| `interaction_prompt{variant:'question'}` | `QuestionRequest` | `InteractionPromptField{type:'select'/'multiselect'}` → `QuestionView` |
| `interaction_prompt{variant:'form'}` | `FormRequest` | `InteractionPromptField` ⊂ `FormField`（缺 `number`，草稿已含） |
| `interaction_approval` | `ApprovalRequest` | `approveLabel/rejectLabel` 保留 |
| `interaction_plan_review` | `PlanReviewRequest` | `allowedPrompts` → `ext`（Claude 专有） |
| `interaction_todo_update` | 非阻塞 → `ToolPresentation{kind:'todo'}` 或 `MarkerItem` | 语义差异见「决策点」 |
| `InteractionResolvedReason` | 同名 | 草稿多一个 `'answered'` |

**有损/host 保留项**：`offset`/`treeEntryId`/`sessionId`（wire 与持久化关注点，留在 host store）；`filePush`/`goalId`/`source` → `ext`。

## 2. intellij-plugin（同源，几乎免费）

| 现有（agent-daemon） | 草稿 | 说明 |
| --- | --- | --- |
| `PlaygroundMessage{role:'assistant', blocks}` | `AssistantTurnItem` | `AssistantBlock` 与 `TurnBlock` 同构（`tool.toolId` → `tool_call.toolCallId`）；冗余的 `content`/`thinking` 累计串不进共享模型（持久化关注点，host 可从 blocks 重建） |
| `PlaygroundToolCall` | `ToolCallView` | `status:'completed'` → `'success'`；`semantic` 直通 |
| `ProviderRuntimeEvent` | `TranscriptEvent` | adapter ≈ 现有 `applyRuntimeEvent()`：`assistant/assistant_delta` → `text_delta{delta\|snapshot}`（snapshot 语义正好消化 legacy provider 的终态全量事件）；`tool_started/finished`、`thinking_delta`、`provider_turn_finished` → `turn_finished`；`mode_transition` → `marker{markerType:'mode_transition'}`；`retry_scheduled` → `marker{markerType:'retry'}` |
| `interaction:'permission'`（PermissionRequest） | `ApprovalRequest` | PermissionDecision 的选项 → `allowedScopes` |
| `interaction:'question'`（`questions[]`） | `QuestionRequest` | 多题结构直接对应 `questions: QuestionView[]` |
| `interaction:'plan_approval'` | `PlanReviewRequest` | |
| `interaction:'elicitation'` | `FormRequest` | `ElicitationField` ⊂ `FormField` |
| `PlaygroundMessage.ideContexts/contextAttachments` | `UserMessageItem.ext` | IDE 专有，kit 不解释；渲染由 host 的 slot/renderer 注入 |

**host 保留项**：`sequence` 去重、`runSessionIds` 路由、`events[]` inspector 缓冲、session tab 管理 —— 全部在 adapter 之上，不进 kit。

## 3. hermes-client-mobile（异构，投影方向已验证）

hermes 是扁平 `ChatEntry[]`，映射方向：wire 事件 → `TranscriptEvent` → 块模型。关键点是它现有事件流的粒度足够：

| 现有 | 草稿 | 说明 |
| --- | --- | --- |
| `message.start/delta/complete` | `turn_started` / `text_delta{delta}` / `turn_finished` | |
| `thinking.delta`、`reasoning.delta` | `thinking_delta` | 内联 `<think>` 标签剥离仍是 layer-2 工具（三家都要） |
| `role:'tool'` 的 `ChatEntry` | 归并进当前 turn 的 `tool_call` block + `ToolCallView` | `tool.start/progress/complete` → `tool_started/activity/finished`；`findRunningToolIndex` 的 tool_id 回退匹配逻辑进 adapter |
| `toolKind: terminal/file/image/search/generic` | `ToolPresentation` 五个 kind 全覆盖 | `parseCompletedTool()` 基本原样变成 adapter 里的 presentation builder；`searchQuery/searchResults` → `{kind:'search'}` |
| `toolSummary/toolDurationSeconds/toolError` | `summary` / `startedAt+completedAt` / `status:'error'` | duration 改为两个时间戳，UI 层算差值 |
| `clarify.request`（有 choices） | `QuestionRequest`（单题） | `choices: string[]` → `options`（value=label） |
| `clarify.request`（无 choices，自由文本） | `QuestionRequest{options:[], allowCustomValue:true}` | |
| `approval.request`（once/session/always/deny） | `ApprovalRequest{allowedScopes:['once','session','always']}` | 回复 `{decision, scope}` 映射回四选一 |
| `sudo.request` / `secret.request` | `SecretInputRequest{secretKind:'password'\|'env_var'}` | |
| `*.expire` | `interaction_resolved{reason:'timeout'}` | |
| `status.update`（compacting） | `MarkerItem{markerType:'compacting'}` | |
| `reactions` / `rowId` / `userOrdinal` | `ext` | reactions 的 UI（长按菜单、emoji 行）留在 hermes 自己的组件层，kit 通过 ext + slot 透出 |

**有损点（可接受）**：hermes 的 `thinking` 是独立 role 条目且 UI 单独成卡；映射成 turn 内 thinking block 后，hermes 若要保持现有视觉可在渲染层把 thinking block 提出来单独渲染 —— 视图模型不丢信息，只是渲染选择。`terminal.read.request` 自动空回复是纯 host 行为，不进交互模型。

## 结论

三家全部能映射进同一套块模型 + 事件流 + 交互联合，没有发现结构性阻塞。决策点及结论：

1. **todo 的归属（已定 2026-08-21）**：时间线按「非阻塞 → presentation/marker」处理，同时 layer-2 reducer 维护一份 latest-wins 的会话级 `todos` 状态并提供 selector（host 可做常驻 todo 面板）。交互联合保持严格阻塞语义（每个 request 必有 response）。zclaudia 的 adapter 把 `interaction_todo_update` 翻译成 marker + 状态更新。
2. **累计串 vs 块（已定 2026-08-21）**：块是唯一真源。kit 只存 `blocks`，导出 `turnText()`/`turnThinking()` selector，host 在持久化/复制等边界重建字符串。intellij 迁移时删除 `content`/`thinking` 双写逻辑；adapter 规则：读 zclaudia 老持久化行（无 `contentBlocks`）时把 `content` 包成单个 text 块。
3. **approval 决策空间（已定 2026-08-21）**：超集 + 能力声明。两个体系是正交扩展——hermes 扩了授权范围（once/session/always），plugin-sdk 扩了 `updatedInput`（改输入放行）与 `message`（拒绝理由）。响应统一为 `{decision, scope?, updatedInput?, message?}`；请求侧 `allowedScopes` / `editableInput` / `timeoutSeconds` / `timeoutBehavior` 声明 host 能力，共享卡片只渲染已声明的能力，adapter 出口忽略未声明能力的响应字段。
