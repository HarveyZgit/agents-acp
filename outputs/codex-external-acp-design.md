# Codex 外部 ACP 协作插件：一次性实施设计

## 目标

把任意本机已安装、支持 ACP 的编码 agent 作为 Codex 的外部协作者使用。首批接入 Grok Build 和 Cursor CLI。运行过程不要求出现在终端；它应在 Codex app 的当前任务中以独立、可展开的运行面板持续展示，类似“任务工作了多久、做了什么、改了哪些文件、最终结果如何”的体验。

这不是让外部 CLI 变成 Codex 原生 subagent。原生任务卡片、任务树和 Review 控件仍属于 Codex 自身；插件交付的是一块可见、可取消、可查看结果和 diff 摘要的外部协作面板。

## 采用的架构

```text
用户请求
  ↓
Codex + 协作 Skill
  ↓ 调用 MCP 工具：start / status / cancel / resume
本地 MCP server（ACP adapter） ── 运行面板（插件自定义 UI）
  ↓ ACP / JSON-RPC over stdio             ↑ 统一事件流
Cursor ACP 或 Grok Build ACP ─────────────┘
  ↓
当前工作区中的读写、测试、计划与最终结果
```

**ACP（Agent Client Protocol）** 是外部 agent 与宿主应用交换会话、进度、权限请求、取消和结果的协议。适配器把 Cursor 与 Grok 的 ACP 消息统一成内部事件；MCP（Model Context Protocol）则是 Codex 插件向 Codex 暴露工具与 UI 的通道。

## 为什么 ACP 是主链路

- 持续接收文本、工具调用、计划、权限请求和任务状态，而不是只等 CLI 退出。
- 用 provider session ID 恢复会话，取消任务也有协议语义。
- 输出面板展示结构化事件，不必解析两家 TUI 或依赖终端是否可见。
- 终端仍可作为开发调试和无法渲染 UI 时的回退，但不是用户主体验。

## 插件组成

```text
external-acp-collaboration/
├── .codex-plugin/plugin.json
├── mcp-server/
│   ├── src/index.ts                 # MCP tools 与 UI resource
│   ├── src/acp/provider.ts          # 可扩展 provider interface
│   ├── src/acp/cursor.ts            # Cursor ACP adapter（首批）
│   ├── src/acp/grok.ts              # Grok ACP adapter（首批）
│   ├── src/run-store.ts             # 会话和事件索引
│   └── src/policy.ts                # cwd、并发、写入边界
├── ui/run-panel/                    # 自定义运行面板
└── skills/external-acp-collaboration/SKILL.md
```

## MCP 工具与面板

| 工具 | 输入 | 输出 |
|---|---|---|
| `list_external_agent_providers` | 无 | 已发现 provider 与能力 |
| `start_external_agent` | provider、任务类型、cwd、prompt、可选 model | run ID、面板引用、初始状态 |
| `get_external_agent_status` | run ID | 状态、当前步骤、事件摘要、session ID |
| `cancel_external_agent` | run ID | 已取消/不可取消状态 |
| `resume_external_agent` | run ID 或 provider session ID、follow-up | 新 run ID、恢复状态 |
| `get_external_agent_result` | run ID | 最终结论、文件变更摘要、错误、验证建议 |

运行面板显示：运行时长、当前活动、文本流、工具/命令、权限请求、改动文件、错误和完成总结。面板可轮询状态；若宿主支持推送更新，则增量刷新。不能假设它会复用 Codex 原生 subagent 的视觉组件。

## 统一事件模型

```ts
type RunEvent =
  | { type: "started"; provider: "cursor" | "grok"; sessionId?: string }
  | { type: "text"; text: string }
  | { type: "activity"; label: string; detail?: string }
  | { type: "permission"; requestId: string; description: string }
  | { type: "file_change"; path: string; kind: "create" | "modify" | "delete" }
  | { type: "error"; message: string }
  | { type: "completed"; summary: string; exitCode?: number };
```

Cursor 和 Grok 的 ACP 扩展事件在各自 adapter 内转换，UI 不直接依赖任一厂商的事件格式。后续 provider 只需实现同一 adapter interface，不改变 UI 或调度规则。

## 模型选择：provider capability，而非 ACP 承诺

ACP 负责会话、事件、权限与取消；它不保证所有 agent 都用同一种方式接受模型选择。因此 `start_external_agent` 接受可选 `model`，但 adapter 必须先报告自己的能力：

```ts
type ProviderCapabilities = {
  supportsModelSelection: boolean;
  modelSelection: "startup" | "session" | "config" | "none";
  supportedModes: Array<"ask" | "plan" | "agent">;
};
```

只有当前 provider/version 的 ACP 启动参数、session 方法或配置机制明确支持时，adapter 才传递 `model`。否则它返回明确错误，绝不把模型名伪装成 prompt 内容。Cursor 与 Grok 的普通 CLI 都提供模型选择能力，但在 ACP 入口是否可以按启动或 session 粒度选择，必须按该版本的官方文档和 `--help` 实测确认。

## 调度、权限与复核

1. 用户点名 Grok 或 Cursor 时，照办。未点名时，架构/风险第二意见优先 Grok；需要已有 Cursor 上下文或 Cursor 配置时优先 Cursor。
2. `review` 与 `plan` 为只读，可并行；`implement` 必须来自明确修改请求，同一工作区写入始终串行。
3. adapter 只允许当前工作区或明确授权子目录为 cwd；不保存密钥、不自动登录或安装 CLI。
4. ACP 权限请求显示在面板并等待用户决定，不自动批准。
5. 外部 agent 写入后，Codex 展示 diff、执行相关验证，并决定是否采纳。

## 生命周期

```text
start → discover → ACP initialize → prompt → streaming
                                      ├─ permission → 用户决定 → continue
                                      ├─ cancel → terminate → cancelled
                                      ├─ error → failed（保留 session）
                                      └─ complete → result → diff + verification
```

长任务由 MCP server 维持进程与事件索引；页面关闭不等于丢失会话。恢复必须在同一 cwd 使用 provider session ID，并重新检查可执行名和登录状态。

## 验收标准

- 在 Codex 当前任务启动后立即出现独立运行面板，并持续显示状态、时长与事件。
- 面板显示最终摘要、错误和文件变更摘要；只读任务可并行，写入任务会串行。
- 权限请求可等待、允许或拒绝；取消会使 ACP 会话进入 cancelled。
- 中断后能恢复；明确 implement 请求后，Codex 显示 diff 与验证结果。
- 插件、运行记录和 UI 均不保存 API key 或认证信息。

## 实施时的只读检查与非目标

实施时只读检查每个 provider 的实际命令、版本、ACP 入口、模型选择能力和登录状态；不安装软件、不启动实际任务、不修改认证信息。

云端 Agent 可以实现、测试 mock ACP 流程和审查代码，但不能访问用户本机 CLI 或认证态。因此云端交付必须把真实 provider 验证清楚标为“待本机完成”，不能宣称已经完成真实端到端测试。

不承诺复用或仿制 Codex 原生 subagent 卡片；不启动全屏 TUI、不做跨项目任务或无限自治循环。非 ACP provider 可另加 headless 回退，但不是主链路。
