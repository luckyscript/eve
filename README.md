# eve · Agent PoC

一个可直接运行的终端 Agent 原型：**Agent Loop、持久任务会话、独立产物验收、skills 按需注入、交互 TUI、分层配置**。

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
| `/sessions` | 列出本地持久会话的 ID、运行数与状态 |
| `/resume ID` | 加载会话上下文，核验 ID，不重放工具 |
| `/new` | 切换新会话 ID，首个任务开始时落盘 |
| `/exit` | 退出 |
| `Ctrl+C` | 执行中取消；空闲时退出 |

每个任务自动保存到当前会话；失败轮次的原始证据保留，续聊加入宿主失败说明。已写入的文件不自动回滚。非 TTY 环境使用 `run --prompt`。TUI 不设置验收契约，需要独立验收时使用 CLI 的 `--contract`。

## 持久会话与独立验收

```bash
node bin/eve.mjs sessions --json
node bin/eve.mjs run --session report-task --prompt "创建 result.json，answer 等于 42，并写后读取核验" --contract .eve/contracts/report.json --json
# 独立进程继续同一会话；每轮验收需再次显式提供 --contract
node bin/eve.mjs run --session report-task --prompt "检查上轮输出并继续" --contract .eve/contracts/report.json --json
```

不指定 `--session` 时自动创建会话，输出 `sessionId`。ID 仅接受 1–64 个 ASCII 字母、数字、下划线和连字符，首位必须为字母或数字。会话由 workspace 隔离；没有同 ID 的账本时 `run` 创建它，`/resume` 则要求它已存在。

先由用户创建可信的 JSON 契约文件，例如 `.eve/contracts/report.json`：

```json
{
  "version": 1,
  "assertions": [
    { "type": "file_exists", "path": "result.json" },
    { "type": "json_equals", "path": "result.json", "field": ["answer"], "value": 42 },
    { "type": "text_contains", "path": "result.json", "text": "answer" },
    { "type": "write_readback", "path": "result.json" }
  ]
}
```

`--contract` 接受相对 workspace 或绝对路径：这是用户显式信任的宿主文件，可以放在 workspace 外或工具不能读写的 `.eve` 内。所有 assertion 的目标仍必须是 workspace 内的安全相对路径；禁止穿越、符号链接和受保护路径。建议把契约放在 `.eve/contracts/`，避免模型修改工作区内的契约源文件。每轮开始就加载并保存契约定义，模型运行后不会重新加载定义。不支持 JS、eval、shell 或模型自评断言。

- `file_exists` 要求普通文件存在。
- `json_equals` 用字符串数组 `field` 逐层选择 JSON 自有字段，空数组表示整个文档；严格比较 JSON 值，缺失字段失败。
- `text_contains` 要求 UTF-8 文本包含指定字符串。
- `write_readback` 要求**本轮**有成功的 `write_file`，宿主独立读回文件，将实际字节 SHA-256 与本轮最后一次同路径成功写入的内容比较；无需相信模型的“已经验证”。

内容断言限 256 KiB；每份文件契约限 256 KiB、1–100 个 assertions。验证从真实文件读取，结果不输出文件正文或 expected/actual 值，记录判定和内容哈希。JSON 输出分别包含 `modelStatus`、`verification.status` 和最终 `status`。有契约时只有模型 `completed` 且验收 `passed` 才成功；口头完成而产物错误返回 `failed` / `ACCEPTANCE_FAILED`、退出码 1。无契约时 `not_requested` 只表示未做独立验收，保持原有完成语义；模型失败时验收为 `not_checked`。`run_end` 是原有模型循环结束事件，`acceptance_end` 给出宿主最终判定。

原始提示、完整模型/工具消息、工具参数/结果、事件、契约、失败与能力快照保存在 ignored `.eve/sessions/ID.json`，文件 0600、sessions 目录 0700。CLI 的摘要不含完整历史，按当前认证配置脱敏；本地原始证据可能包含敏感文件内容，请按凭据文件管理。文件工具不能访问 `.eve`；`load_skill` 只允许通过宿主返回当前快照中的已发布字节。`.eve/state/` 也已预留并忽略。

账本是 version 1 JSON；每个检查点在同目录写私有临时文件、fsync、rename，再同步目录。每会话锁跨进程排斥写者，活跃锁明确拒绝；PID 已消失时回收死锁。损坏账本拒绝覆盖，遗留临时文件不参与加载。锁采用本机 PID，PID 被重用时保守拒绝，异常遗留 `.lock.reap` 需人工确认无写者后处理。不同会话不互斥共享 workspace 的产物写入。

中断后的首次 load/list/resume 把未结束运行标为 `interrupted`，未决工具意图标为 `unknown`；不会自动重新调用任何工具。续聊只构造派生历史，为缺失 tool result 补充 unknown 结果以维持模型协议，原始账本消息不被改写。失败轮次和已完成的同批工具结果保留。**这不是任意工具中间点无损恢复或 exactly-once 执行**：崩溃/取消窗口中的写入必须核验实际文件，再由新任务决定下一步。原子保存也不等于产物的多文件事务或 OS 安全沙箱。

进化层由宿主调用 `loadSession(cwd, id)` / `listSessions(cwd)`，读取 `runs[].status/error/verification`、`contract`、`capabilitySnapshot`（工具 schema、模型与已发现技能的哈希）、`tools` 与原始 `messages/events`。`openSession().save()/close()` 为显式保存接口；`sessionHistory()` 仅构建续聊视图。技能候选生成与评测发布见下节。

新增真实验证：`npm run verify:sessions-live`。它用已有本地配置，在隔离 workspace 中通过三个独立 CLI 进程验证创建、历史续聊和错误产物拒绝；保留 ignored 私有账本，清除临时复制的认证文件，脱敏摘要写入 `.eve/runs/session-verification.json`。实际记录见 [会话功能验证](docs/session-feature-verification.md)。

## 可验证的技能自进化

手工维护的 `skills/**/SKILL.md` 仍是 **trusted user** 指令，不是进化系统发布的候选。普通工具现在禁止写入配置的技能根目录或任何 `SKILL.md`，防止绕过验收。用户可以手工编辑原始技能；参与进化前显式导入 baseline，同名 active 存在时禁止再次 import 覆盖：

```bash
node bin/eve.mjs evolve import --file skills/inventory-report/SKILL.md
node bin/eve.mjs run --session inventory-dev --contract .eve/contracts/report.json --prompt "使用 inventory-report 生成报告"
# 使用上一步 JSON 输出中的 runId；source 必须契约失败且实际加载当前 active hash
node bin/eve.mjs evolve --session inventory-dev --run r-UUID --skill inventory-report --suite .eve/suites/inventory.json --correction "逐行 trim、丢弃空行、保留重复和顺序" --max-requests 45
node bin/eve.mjs capabilities
node bin/eve.mjs evolve rollback inventory-report
```

默认评测成功后自动发布；`--no-promote` 只评测，之后 `evolve promote c-UUID` 发布。没有评测、评测失败、证据 hash 改变或 parent CAS 冲突均拒绝发布。回滚撤回当前版本，**只影响未来运行，不撤销文件等外部副作用**；已启动运行保存的 skill hash/字节不会热换。baseline 不可再回滚。

用户创建可信的声明式 suite（建议 `.eve/suites/NAME.json`，工具无法读取）。没有 JS、eval、脚本字段：

```json
{
  "version": 1,
  "maxCandidates": 1,
  "budget": { "maxSteps": 5, "maxToolCalls": 12, "maxOutputTokens": 2048, "timeoutMs": 90000 },
  "cases": [
    {
      "id": "trim-and-blank",
      "files": { "inventory.txt": " apple \n\n pear\n" },
      "prompt": "使用 inventory-report 生成 report.json，然后读回",
      "contract": {
        "version": 1,
        "assertions": [
          { "type": "json_equals", "path": "report.json", "field": ["items"], "value": ["apple", "pear"] },
          { "type": "json_equals", "path": "report.json", "field": ["count"], "value": 2 },
          { "type": "write_readback", "path": "report.json" }
        ]
      }
    }
  ]
}
```

suite 支持 1–12 个 cases，每个 case 独立 input files、prompt、contract。文件只允许普通安全相对路径，不能注入技能、点目录或受保护文件；最多 30 份，每份 64 KiB。契约复用 `file_exists/json_equals/text_contains/write_readback`，另支持 `text_equals`（`text` 字段）和 `sha256_equals`（`sha256` 为 64 位小写十六进制）。输出目标同样隔离。suite 总计最多 256 KiB。

宿主在生成前冻结 suite 原文和 SHA-256；候选内容同样固定 hash。生成器通过独立的**无工具**模型请求，仅接收原始任务、失败状态/代码、用户公开 correction 与旧技能正文，不接收 source contract、隐藏 prompts/files/assertions、suite 路径或逐题日志。它真实生成完整 frontmatter 和技能正文，宿主校验格式，然后各 case 对 baseline/候选分别建立 `.eve/evolution/experiments/` 内独立 workspace，只复制对应技能和声明的输入。两方使用同一模型配置、工具权限、步数/输出 token/工具数/超时预算，真正执行模型工具循环，按磁盘产物和实际 `load_skill` hash 验收。

MVP 发布策略：候选全 cases 通过、baseline 至少一例契约失败，所有运行必须正常完成并实际加载对应技能。baseline 正确 cases 因而零退步；缺加载、超时、中断等不确定结果均不发布。**这些只是小样本局部证据，不是一般能力提升保证**。不允许候选静态解析或模拟输出来替代真实输出验收。隐藏案例在执行阶段会供评测模型完成其任务，但不会反馈到生成器；本版没有把逐题日志迭代发送给生成器的搜索循环。

进化付费必须显式提供 `--max-requests N`（1–100），开始前校验最坏请求数 `1 + 2 × cases × maxSteps` 不超预算，生成调用计 1 次；输出 token 请求上限为该请求数乘 `maxOutputTokens`。每轮上下文仍有既有 200k 字符硬上限，模型 usage 只作实测统计，不估算货币费用。suite 默认预算为 6 steps/12 tools/2048 output tokens/60s；最大 12/24/4096/120s。`--evolution-timeout-ms` 控制整个实验，默认 600000，最高 1800000。持久谱系限制 `maxCandidates` 为 1–3，首次实验锁定上限，后续不能提高；失败生成也消耗一次机会，不能反复查询同一候选。不同谱系预算独立。

一次命令启用日常自动进化：

```bash
node bin/eve.mjs run --session inventory-dev --prompt "使用 inventory-report 生成报告" --contract .eve/contracts/report.json --auto-evolve --skill inventory-report --suite .eve/suites/inventory.json --correction "逐行 trim，丢弃空行" --max-requests 45 --json
```

自动模式在原任务开始前冻结 suite，原任务不能替换本次评测定义。只有本轮契约失败才触发，**至多一个候选**，不重放原任务，不改写原任务失败状态；新技能从下一任务生效。预算是该次进化附加预算，原任务使用普通运行预算。自动流程失败返回 `evolution.status:failed`，原任务仍可检查。TUI 保持现有行为。

registry 的 content-addressed skill objects、candidate/evaluated/active/rejected/revoked 状态、parent/source run/contract hash、模型配置 hash、实验与验收日志保存于 ignored `.eve/evolution/`，目录 0700、宿主文件 0600。状态写入 fsync/rename，跨进程锁保护 publication CAS；崩溃遗留 `publish.lock` 时保守拒绝，需用户确认无写者后处理，不自动偷锁。active 指针在每轮开始读取一次，普通发现永不扫描未发布候选。`load_skill` 通过宿主返回已验证的发布字节，文件工具不能读写 registry。可信用户若直接修改私有状态属于本机信任边界外，不是防 root/OS 攻击的沙箱。

`npm run verify:evolution` 会调用现有真实模型并产生费用：故意不完善的手工 baseline → 真实失败 source → 真实生成 → 四组隐藏边界案例对照 → 晋级 → 独立进程成功加载新 hash → 回滚及独立进程加载旧 hash → 拒绝无测试候选且 active 不变。最多 56 次模型请求（进化配置 ceiling 41，外加三个 5-step runs），总体超时默认 10 分钟，可用 `EVE_EVOLUTION_VERIFY_TIMEOUT_MS` 调到最多 30 分钟。报告 `.eve/runs/evolution-verification.json` 和私有实验账本保留，即使失败也不修改断言。每次脚本创建新的隔离演示谱系；生产谱系不会被重置。

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
3. 加载时验证路径与发现时 SHA-256；文件已变化则要求重新运行。已发布技能返回本轮快照固定字节；续聊历史中的上轮技能 tool 正文会在派生上下文中过期，须重新加载当前快照，原账本保持不变。
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

这是单用户、可信本地工作区的 PoC，支持经过显式启用和局部对照验收的技能生成与晋级；不训练模型。背景设计见 [技术方案](docs/eve-agent-technical-proposal.md)。

- 不执行 shell、安装依赖、访问任意网络工具，文件工具仅可访问 workspace。
- 阻止 `..`、绝对路径、符号链接，以及 `.git`、`.eve`、`.env*`、`*.local.json` 等受保护路径。
- 路径检查不是 OS 沙箱，仍存在恶意并发换路径的 TOCTOU 风险；不要用于不可信多租户或恶意工作区。
- 用户任务授权写入由模型指令表达，本版没有逐次审批 UI；只在允许模型修改的工作区运行。
- 支持持久会话和任务边界续聊；不支持进程中间点 exactly-once 恢复、工具自动重放、原子多文件事务、自动补偿或自动上下文压缩。上下文过大时明确报错并要求 `/new`。
- 模型 API 超时/HTTP 错误明确失败，不将半成品输出标为完成；不自动切换模型。
- token 统计依赖兼容服务返回的 usage，不估算货币费用。

## 代码导航

```text
bin/eve.mjs                 CLI 入口
src/config.mjs              配置与脱敏
src/skills.mjs              发现、元数据、按需加载与哈希校验
src/tools.mjs               工具 schema、参数和路径检查
src/agent.mjs               模型协议、执行循环、预算与事件
src/tui.mjs                 终端界面与会话选择
src/sessions.mjs            私有账本、锁、原子保存、边界恢复与任务验收编排
src/contracts.mjs           声明式契约加载、路径检查与独立读回验收
src/registry.mjs            不可变技能对象、私有状态、CAS 发布和回滚
src/evolution.mjs           无工具生成器、冻结 suite、独立对照评测
scripts/verify-evolution.mjs 真实模型进化、独立进程加载和回滚验证
test/evolution.test.mjs     进化、安全边界和发布状态测试
skills/workspace-report/    示例技能
scripts/verify-live.mjs      随机标记的真实模型验证
test/core.test.mjs           原有 10 项核心与回归测试
test/sessions.test.mjs       持久化、跨进程、崩溃、验收、安全边界测试
scripts/verify-sessions-live.mjs  真实模型会话续聊与独立验收
```
