# Eve 原生 macOS 客户端

客户端由 SwiftUI / AppKit 构建，SwiftPM 项目位于 `macos/Package.swift`，可以用 Xcode 打开。复用既有 Node 业务核心，没有 Electron、Tauri、WebView、HTTP bridge 或 shell 工具。

## 构建和启动

在仓库根目录运行：

```sh
scripts/build-macos.sh
open dist/Eve.app
swift test --package-path macos --scratch-path .build/macos
```

构建产物、Swift 中间文件均在 workspace 内并被 gitignore。脚本从固定 `/usr/local/bin/node` 复制 Node 到 bundle，检查非系统 dylib，构建原生 release binary、Info.plist，并进行 ad-hoc 签名验证。它不会安装到 Applications 或创建登录项。当前产物针对本机 arm64 验证，未 notarized，没有开发者分发证书；仅检查 Node dylib 并不意味着可以向任意 Mac 分发。

首次启动使用原生 NSOpenPanel 选择工作区，之后记忆上次目录。命令行开发运行也使用同一原生界面，需固定路径 `/usr/local/bin/node`。bundle 只包含白名单内的 bridge、src、skills 与 Node，不复制 `.eve`、用户配置或本机凭据。

## 操作

- Sidebar：选择工作区、新会话，点击持久会话恢复；新任务在同一会话接续。会话恢复沿用核心锁及中断恢复机制，不重放未确定工具。
- 聊天与任务：输入任务，Command-Return 或“运行任务”。实时工具时间线独立于模型结束和最终验收；每轮显示任务状态、模型状态、验收状态及每项断言、请求统计。可查看上下文状态和执行手动压缩。
- 验收契约：通过文件 picker 选择 JSON；宿主验证格式及目标路径，模型完成后核心独立读回文件。未选契约显示 not_requested，而不是验收通过。
- Tools：原生卡片展示实际工具 schema；Skills：原生表格展示发现结果、哈希和警告。可以导入可信 SKILL.md 作为新技能基线。
- Capabilities：查看 active 指针、候选及状态。evaluated 候选可以手动发布，发布仍由核心验证证据和 CAS。回滚只影响下个任务技能，不撤销工作区文件。
- 设置：原生 Form 覆盖 baseUrl（含模型端口）、model、maxSteps/maxToolCalls/timeoutMs/maxOutputTokens/maxToolChars/temperature、contextMaxChars/contextRecentGroups/contextSummaryChars、skillsDirs（每行目录）、userSkills。核心验证预算，仅保存编辑过的字段，保存后重新显示有效值。脱敏字段不会因其他字段修改而被写回；若要编辑脱敏字段，须输入完整新值。环境变量仍优先于本地配置。
- 进化：选择 source session/run、当前发布 skill、公开 correction、picker 选择 suite、显式 maxRequests 与 timeoutMs、autoPromote，开始或在顶栏取消。展示 baseline/candidate case 得分、确定性、实验状态、记录保存异常及实际 active hash。来源必须已经加载当前技能并有真实契约失败。suite 预算不足时在模型请求前拒绝。
- 失败后自动进化：先在进化页配置 skill/suite/预算，再在聊天页选择契约并勾选开关。仅契约失败后尝试一次，不重放原任务；可关闭 autoPromote，之后手动发布。

## 权限、密钥和管道

这是可信本地工作区应用，无 OS sandbox，不需要辅助功能权限来正常使用。自动化 UI 验证工具需要其自身的辅助功能及屏幕录制权限。

当前密钥只显示 configured/not configured。新密钥通过 SecureField、stdin 请求交给宿主，写入 `.eve/config.local.json`，权限 0600，使用私有原子替换，拒绝符号链接；保存前宿主检查该路径未被 Git 跟踪，并在选定工作区的 `.gitignore` 末尾确保 `/.eve/config.local.json` 规则；拒绝符号链接和已跟踪的本地配置。检查只使用固定 `/usr/bin/git` 的只读 ls-files 命令，不经过 shell。此规则可能使其他工作区的 `.gitignore` 产生可审阅的修改。密钥不会出现在进程参数或 bridge 日志中。外部 `EVE_API_KEY` / `EVE_CONFIG` 仍遵循原配置优先级。

Swift Process 直接运行固定 Node 和固定 bridge 文件。stdin/stdout JSONL 使用 requestID，操作 allowlist、参数与 256 KiB 输入上限；事件只投影类型、工具名和状态，不发送 arguments、工具正文、完整 history、headers 或原始配置。字符串递归脱敏包括模型回显密钥。stderr 被排空但不渲染。

宿主持有规范化 workspace，操作串行；busy/cancel 可在运行期间读取/提交。原生界面在任务期间禁止切换工作区和会话。取消通过 AbortController 请求，等待核心落盘与锁释放后恢复操作；不会杀掉写入进程伪称回滚。EOF 会请求取消并等待收尾。输出排队处理管道背压；异常退出和协议错误在 UI 明确显示。运行中退出应用会提示先取消并等待。

## 验收证据

验收在本机 macOS 27.2 arm64、Xcode 27 / Swift 6.4、Node 22 环境执行。首个 bridge 提交 `dbf5326` 推送后：原 61 项测试加 5 项 bridge 测试（66/66）、原语法检查与 11 项 PTY 检查通过。后续新增完整进化 API 测试覆盖评分、发布、回滚、自动进化和压缩，不以按钮存在代替业务验证。


真实验收第一轮（源码 `9a46fd264a47ee5e704152258baaaeba29e587fd`）：打包内 Node 运行打包内同一 bridge，9 次请求通过技能加载、工具写读、独立契约、跨新进程会话继续、手动压缩、注册表和实验操作读取。原生 UI 使用辅助功能真实填写任务并点击运行，另用 3 次请求完成文件写入和读回；运行中工作区按钮禁用，最终任务与模型均 completed。

UI 自动化边界：原生窗口、任务输入、运行按钮、运行状态及最终结果已检查；NSOpenPanel 的目录选择按钮可操作，但后台自动化不能可靠选择文件条目。该 UI 任务未附契约，界面准确显示 not_requested。独立契约的真实模型验收由打包 bridge 完成；不能声称“UI picker 到最终契约通过”的全链路已自动化通过。Tools、Skills、Capabilities、进化、设置和聊天六个页面均在真实原生窗口中点击打开并留存截图；未逐个执行所有页面中的写操作，也未完成 picker 到验收通过的 UI 链路。

本轮不重复完整付费进化 demo。进化来源选择、公开 correction、suite 冻结、预算检查、baseline/candidate 评分、手动发布、回滚、一次自动进化、取消和失败记录由真实核心 API 加可控模型响应覆盖。此测试验证 bridge 的业务接入，不是任意模型下都能提高技能的保证。

实际请求证据保存在忽略追踪的 `.eve/runs/macos-live-verification*.json`、`macos-live-requests*.jsonl`、`macos-ui-verification.json`；UI 原始会话也保留在私有会话账本，临时样例与复制的配置会清理。验证脚本 `npm run verify:macos` 每次有 18 次请求的硬上限，会产生模型费用，并在结束后清理测试工作区。最终交付回归与源码证据见后续验收记录。

输入帧上限 256 KiB；原生响应 decoder 上限 2 MiB。特别大的累计会话可能触发明确的协议限额错误，需要在 CLI 检查账本并使用新会话；本版没有历史分页。取消和回滚均不撤销已写入的用户文件。


## 最终验收记录

功能代码版本：`e7e04ed`（最后一项为原生设置仅保存改动字段）；最终文档提交后，bundle 的 `EveSourceRevision` / `Resources/source-revision.txt` 跟随最终 HEAD。真实模型 bridge 验证代码版本 `ad9715714497df223e2e0f5fcec70fc198473e82`，其打包 core + bridge 指纹为 `c53ba1a4d7d36297ce8bf1359e951d26ecb0693264ba5a8c1faf1f10811ba550`。后续原生设置修复及文档变更不改变该 Node 代码指纹；交付前重新核对。

| 检查 | 结果与范围 |
|---|---|
| Node 全量回归 | 72/72：原 61 项、10 项 bridge 测试、1 项预取消 Promise 竞态测试 |
| 语法 | 原有全部检查及新 orchestration、bridge 三模块、原生验收脚本通过 |
| 真实 PTY | 11/11，通过原 CLI / TUI 的启动、帮助、技能、状态、配置、会话、恢复、压缩与退出 |
| Swift 测试 | 6/6：Unicode 分帧、多帧、消息限额、截断 EOF、无效帧，以及配置改动状态与脱敏保存保护 |
| 原生构建 | Swift 6 release、Info.plist、bundle 结构、内置 Node 系统 dylib 检查、ad-hoc codesign verify 通过 |
| Bridge 协议 | JSONL 真实子进程覆盖配置、非法/超长消息、断开的 stdout；可控模型覆盖工具任务、契约、取消、压缩、进化评分、发布、回滚、一次自动进化和取消后的失败记录 |
| 真实模型 | 第一轮 9、原生 UI 3、第二轮 11、最终打包短任务 4，共 **27 次请求**；后续审计硬限额使本轮累计不超过 30 |
| 最后打包短任务 | 实际加载技能，write_file / read_file 成功，text_equals 与 write_readback 两项独立断言通过 |
| 原生 UI | 真实点击运行、显示 completed / completed / not_requested；最终应用重新启动并从私有账本恢复该 UI 会话，六个工作台页面打开成功 |

具体报告及完整命令输出保留在忽略追踪的 `.eve/runs/`：`macos-final-node.log`、`macos-final-swift.log`、`macos-packaged-tests.log`、`macos-package.log`、`macos-final-package-live.json`、两轮 `macos-live-verification*.json`、`macos-ui-verification.json`、六页 `macos-ui-*.jpg`。报告不含密钥、完整模型提示或私有 session 原文；临时测试工作区和复制配置已清理，UI 的原始账本继续私有保留。

审阅方式：遵循用户“不派 agent”，由作者按 review 清单自审，未进行独立 reviewer 审查。自审发现的取消 Promise、EPIPE 收尾、外部工作区密钥忽略、空 correction 兼容、脱敏配置误覆盖均有复现/回归测试并已修复。大型会话无分页、picker 后台自动化边界及未 notarized / 未跨机验证仍是本版明确限制。
