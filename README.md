# eve · Agent PoC

一个可直接运行的终端 Agent 原型：**Agent Loop、skills 发现和按需注入、交互 TUI、分层配置、可重复验证**。

使用 Node.js 22+ 的原生模块，无第三方运行依赖，无需 `npm install`。本版使用自行实现的最小 OpenAI-compatible 工具循环，**未接入 Pi 或 DeepSeek Harness**；先固定 eve 的工具/技能/验证接口，后续可以替换运行时。

## 启动

在项目根目录：

```bash
npm start
```

默认连接本地服务 `http://127.0.0.1:3425/v1`，模型为 `macmini-magpie/bailian-token-plan/qwen3.8-max`。认证从忽略追踪的 `.eve/config.local.json` 或 `EVE_API_KEY` 获取，不写进源码。

首次自行部署时：

```bash
npm run eve -- config init
```

然后编辑 `.eve/config.local.json` 加入 `apiKey`；也可以通过环境变量设置。不要把密钥放在命令行参数里。`config init` 不覆盖已有文件；本工作区如已完成实测，本地配置可能已经存在。

查看实际配置与技能：

```bash
npm run eve -- config show
npm run eve -- skills
npm run eve -- config set maxSteps 10
```

密钥显示为配置状态；不输出明文。配置环境变量优先于文件，因此 `config set` 后可能仍由环境变量覆盖。

单次任务和 JSON 输出：

```bash
npm run eve -- run --prompt "列出当前目录，并读取 package.json，说明这个项目怎么启动。"
node bin/eve.mjs run --prompt "列出当前目录" --json
```

自动化建议直接执行 `node bin/eve.mjs`，避免 npm 在 stdout 添加脚本标题。成功退出码为 0，失败/预算耗尽/取消为 1。JSON 输出含状态、统计与工具事件，不包含完整聊天或文件正文。

## TUI

TUI 为滚动式终端界面，使用 readline 与 ANSI 状态显示，需要真实 TTY。显示模型步骤、工具启动/成功/失败、技能名、注入字符数和 token 统计。响应为整段显示，本版不做逐 token 流式渲染。

| 命令 | 功能 |
|---|---|
| `/help` | 查看帮助 |
| `/skills` | 发现并列出可用技能 |
| `/config` | 显示脱敏配置 |
| `/config set maxSteps 8` | 保存本地配置，重置会话 |
| `/new` | 清空内存中的会话 |
| `/exit` | 退出 |
| `Ctrl+C` | 执行中取消；空闲时退出 |

会话仅在当前进程内保留；失败的轮次不加入后续会话，已写入的文件不自动回滚。非 TTY 环境使用 `run --prompt`。

## Agent Loop

```text
发现 skills → system 注入技能目录元数据 → 模型请求
  → assistant.tool_calls → 参数校验 → 串行执行工具
  → role=tool + tool_call_id 结果 → 下一轮模型请求
  → 最终文本 / 明确失败 / 步数、工具数、超时或取消
```

内置工具：

- `list_files`：列出 workspace 相对目录，最多 200 项。
- `read_file`：读取普通 UTF-8 文件，最大文件 256 KiB，返回内容按配置截断并标记。
- `write_file`：创建或替换 workspace 内的文件，最大 64 KiB；允许创建父目录。
- `load_skill`：按发现时的名字加载技能正文，结果作为 tool message 注入下一次模型请求。

工具参数必须为已声明 schema 的字符串字段；未知工具、非法 JSON、缺失字段或越界路径以工具错误反馈模型，可继续纠正。工具串行，避免写入与读取顺序竞争。截断的模型响应不执行其中的工具调用。

预算为每次运行独立的模型请求数、工具尝试数、wall-clock 与单次模型输出 token 上限；不做无界自动重试。调用超时会中断等待和后续调度；底层已经开始的 I/O 不保证被撤销，取消后的写入需核验实际文件。

## Skills：发现与注入

项目技能位于 `skills/**/SKILL.md`，默认还发现 `~/.config/eve/skills`。配置 `skillsDirs` 可指定其他路径；项目目录先发现，重名保留先发现项并给出警告。每次运行重新发现。

```markdown
---
name: my-skill
description: A concise description of when to use this skill.
---

Write concrete steps, required inputs, expected output and verification here.
```

frontmatter 是明确限制的子集：单行 `key: value`，必填 `name` 与 `description`；不支持完整 YAML、多行描述和 YAML 对象。名字使用小写字母、数字和连字符。技能最大 32 KiB，最多发现 100 个技能，遍历深度最多 8 层、目录项预算 1000；符号链接跳过。

1. system prompt 只注入技能名字与描述，不预加载全部正文。
2. 模型遇到匹配任务调用 `load_skill`。
3. 加载时验证路径与发现时 SHA-256；文件已变化则要求重新运行。
4. 完整正文通过 tool result 进入模型后续上下文，事件记录技能名、哈希与注入长度。

示例技能：[workspace-report](skills/workspace-report/SKILL.md)。在一个包含 `inventory.txt` 的工作区中，请求“生成工作区报告”会引导模型加载该技能并创建 `report.json`。模型是否遵循技能应通过 trace 和输出验证，而非只看最终自述。

技能及其描述是受用户信任的本地指令资源；这不是对任意第三方恶意技能的安全隔离。不要加载不可信目录。

## 配置

覆盖顺序，从低到高：

1. 代码默认值。
2. `~/.config/eve/config.json`。
3. workspace 的 `.eve/config.json`。
4. workspace 的 `.eve/config.local.json`。
5. `EVE_CONFIG` 指定的 JSON 文件。
6. 环境变量。
7. CLI 的 `--model` / `--base-url`。

workspace 由 `--cwd DIR` 指定，默认当前目录。配置中的相对 skills 路径按 workspace 解析。

可参考 [.eve/config.example.json](.eve/config.example.json)。常用环境变量：`EVE_BASE_URL`、`EVE_MODEL`、`EVE_API_KEY`、`EVE_MAX_STEPS`、`EVE_MAX_TOOL_CALLS`、`EVE_TIMEOUT_MS`、`EVE_MAX_OUTPUT_TOKENS`。

| 配置 | 默认值 | 含义 |
|---|---:|---|
| `maxSteps` | 12 | 每轮任务最大模型请求数 |
| `maxToolCalls` | 24 | 每轮任务最大工具尝试数 |
| `timeoutMs` | 90000 | 每轮总超时；本地测试配置可提高 |
| `maxOutputTokens` | 4096 | 每次模型响应输出上限 |
| `maxToolChars` | 16000 | 读取文件返回的字符上限 |
| `temperature` | 0 | 模型温度 |
| `skillsDirs` | `["skills"]` | 项目技能目录 |
| `userSkills` | true | 是否发现用户级技能 |

未知字段、非法类型、超出 PoC 限额等均报错，不静默吞掉。`config set` 写入权限为 0600 的本地配置，拒绝直接设置密钥参数，避免密钥进入终端历史。

## 验证

```bash
npm test
npm run check
npm run verify:tui
npm run verify:live
```

- `npm test`：可控模型响应下验证多轮工具协议、技能按需注入、错误纠正、路径与参数限制、配置优先级、超时取消、预算、截断响应与拒绝写入的副作用。
- `npm run check`：使用 `node --check` 对运行模块做语法检查；不是 TypeScript 类型检查。
- `npm run verify:tui`：在真实 PTY 中检查 TUI 启动、帮助、技能列表、配置、新会话与退出；仅此验证脚本需要 macOS/Linux 的 Python 3 标准库，不调用模型。
- `npm run verify:live`：真正调用当前配置的模型服务；会产生模型请求费用/本地资源消耗。

真实模型验证会在 workspace 的 `.eve/verify-live-*` 中创建隔离样例，注入随机数据，并在技能正文内加入一个不出现在用户提示和目录描述中的随机标记。判定必须同时满足：

1. trace 显示技能被发现，并在任务文件工具前成功加载。
2. 技能正文确实作为 tool result 进入循环。
3. 模型发生工具后的续跑。
4. 输出 JSON 与随机输入一致，并包含仅在技能正文出现的标记。
5. 写入后实际读回文件。

脚本断言这些可观测事实，不接受模型口头说“已完成”作为通过。结果保存到忽略追踪的 `.eve/runs/live-verification.json`；无论成功或失败都会清理该次输入与输出样例。报告保留事件与判定，不保存密钥或完整提示内容。

## 边界

这是单用户、可信本地工作区的 PoC，尚无自动技能生成、评测晋级、自我修改或模型训练；后续进化设计见 [技术方案](docs/eve-agent-technical-proposal.md)。

- 不执行 shell、安装依赖、访问任意网络工具，文件工具仅可访问 workspace。
- 阻止 `..`、绝对路径、符号链接，以及 `.git`、`.eve`、`.env*`、`*.local.json` 等受保护路径。
- 路径检查不是 OS 沙箱，仍存在恶意并发换路径的 TOCTOU 风险；不要用于不可信多租户或恶意工作区。
- 用户任务授权写入由模型指令表达，本版没有逐次审批 UI；只在允许模型修改的工作区运行。
- 没有持久会话、崩溃恢复、原子多文件事务、自动补偿、自动上下文压缩。上下文过大时明确报错并要求 `/new`。
- 模型 API 超时/HTTP 错误明确失败，不将半成品输出标为完成；不自动切换模型。
- token 统计依赖兼容服务返回的 usage，不估算货币费用。

## 代码导航

```text
bin/eve.mjs                 CLI 入口
src/config.mjs              配置与脱敏
src/skills.mjs              发现、元数据、按需加载与哈希校验
src/tools.mjs               工具 schema、参数和路径检查
src/agent.mjs               模型协议、执行循环、预算与事件
src/tui.mjs                 终端界面与会话
skills/workspace-report/    示例技能
scripts/verify-live.mjs      随机标记的真实模型验证
test/core.test.mjs           核心与回归测试
```
