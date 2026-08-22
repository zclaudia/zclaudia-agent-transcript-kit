# agent-transcript-kit（草稿）

跨 hermes-client-mobile / intellij-idea-coding-agent-plugin / zclaudia 复用的
agent 对话「视图模型 + headless 逻辑 + transcript 渲染件」组件库的类型草稿。

**状态：讨论稿。** 目的是验证三个项目的消息模型能否收敛到一套共享类型；
映射验证见 [docs/mapping.md](docs/mapping.md)；三个 host 的 adapter 施工
清单、layer-2/3 剩余项与环境备忘见 [docs/roadmap.md](docs/roadmap.md)。

## 分层

```
layer 1  schema        src/transcript.ts   视图模型（块结构 transcript）
                       src/interaction.ts  统一阻塞交互（approval/question/form/plan/secret）
                       src/events.ts       adapter 契约（归一化流式事件）
layer 2  headless      src/state.ts        reducer（TranscriptEvent → 状态；
                                           幂等重放、隐式 turn upsert、
                                           turn 结束清理交互/取消 running tool、
                                           latest-wins todos 状态）
                       src/selectors.ts    turnText/turnThinking/orderedToolCalls/
                                           activeTurn/pendingInteraction
                       src/guards.ts       dev-only assertTranscriptEvent()
                       src/text-utils.ts   mergeStreamText（delta|snapshot）、
                                           splitThinkTags、stabilizeStreamingMarkdown
                       src/delta-batch.ts  delta 合批（rAF/16ms 窗口，framework 无关；
                                           相邻同 turn delta 合并、生命周期事件同步冲刷）
                       src/tool-classify.ts tool 分类器（name+input+result →
                                           ToolPresentation；含 toolSummary/
                                           normalizeToolInput/normalizeTodoItems）
                       src/diff.ts         diff 工具（LCS 行 diff + 400 行上限、
                                           unified diff 解析、diffStats、路径提取）
                       tests/run.ts        零依赖测试（tsc 编译 + node 直跑）
layer 3  components    （未起草）Markdown/CodeBlock、ToolCallCard、
                       ThinkingBlock、DiffView、InteractionCard；
                       theme 走 CSS 变量 token
```

核心切面：**统一的是渲染视图模型，不是线协议。** 三个 host 各自保留 wire
协议，只写一个 adapter 把 wire 事件翻译成 `TranscriptEvent`。session 路由、
seq 去重、断线对账都留在 host 侧，进入 kit 的事件已经归属单一 transcript
且有序。

## 关键设计决策

- **块结构而非扁平**：采用 zclaudia/intellij 已有的 text→tool→text 交错块
  模型；hermes 的扁平 `ChatEntry` 可无损投影过来（反向不行）。
- **tool 渲染按 presentation 不按 toolName**：`ToolPresentation`
  （terminal/file_edit/search/image/todo/generic）由 adapter 归一化，UI 零
  toolName 分支——合并 hermes `toolKind` 与 zclaudia `ToolEffect/ToolSemantic`
  两套思路。
- **开放扩展**：所有 item/tool/interaction 带 `ext` 透传槽；时间线杂项走
  `MarkerItem{markerType}` + renderer registry（zclaudia
  `toolRendererRegistry` 模式的推广），host 可注册私有卡片而不 fork kit。
- **delta | snapshot 双语义**：`text_delta` 同时支持追加与全量快照，消化
  intellij legacy provider 的终态全量事件，不需要各 host 重写合并逻辑。

## 已定决议（2026-08-21）

1. **todo 归属**：时间线走 presentation/marker；layer-2 reducer 另维护
   latest-wins 的会话级 `todos` 状态 + selector。交互联合保持严格阻塞语义。
2. **累计串 vs 块**：块是唯一真源，kit 导出 `turnText()`/`turnThinking()`；
   host 在持久化/复制边界重建字符串，intellij 迁移时删除双写逻辑。
3. **approval 决策空间**：超集 + 能力声明。响应
   `{decision, scope?, updatedInput?, message?}`；请求侧 `allowedScopes` /
   `editableInput` / `timeoutSeconds` / `timeoutBehavior` 驱动 UI，
   未声明的能力不渲染、adapter 出口忽略。
4. **包归属**：发 `@zclaudia` scope（如 `@zclaudia/transcript-kit`）、
   源码独立仓库，不进 zclaudia 应用 monorepo。kit 保持零依赖，
   不 import 任何 host 生态类型；adapter 全部住 host 侧。
5. **运行时校验**：dev-only 手写守卫（`assertTranscriptEvent()`），
   开发构建逐事件校验、生产跳过；不引入 zod。kit ↔ adapter 的版本
   漂移由编译期 TS 拦截，wire 层漂移是 host 自己的课题。

## 落地顺序（沿用先前评估）

1. layer 1+2 成包，替换 intellij 的 vendored `state.ts`/`protocol.ts`，终结漂移；
2. layer 3 transcript 渲染件，zclaudia 先做 store 依赖 props 化；
3. hermes 最后接入，可只接 layer 1+2。
