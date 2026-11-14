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
- 设置：原生 Form 覆盖 baseUrl（含模型端口）、model、maxSteps/maxToolCalls/timeoutMs/maxOutputTokens/maxToolChars/temperature、contextMaxChars/contextRecentGroups/contextSummaryChars、skillsDirs（每行目录）、userSkills。核心验证预算，保存后重新显示有效值。环境变量仍优先于本地配置。
- 进化：选择 source session/run、当前发布 skill、公开 correction、picker 选择 suite、显式 maxRequests 与 timeoutMs、autoPromote，开始或在顶栏取消。展示 baseline/candidate case 得分、确定性、实验状态、记录保存异常及实际 active hash。来源必须已经加载当前技能并有真实契约失败。suite 预算不足时在模型请求前拒绝。
- 失败后自动进化：先在进化页配置 skill/suite/预算，再在聊天页选择契约并勾选开关。仅契约失败后尝试一次，不重放原任务；可关闭 autoPromote，之后手动发布。

## 权限、密钥和管道

这是可信本地工作区应用，无 OS sandbox，不需要辅助功能权限来正常使用。自动化 UI 验证工具需要其自身的辅助功能及屏幕录制权限。

当前密钥只显示 configured/not configured。新密钥通过 SecureField、stdin 请求交给宿主，写入 `.eve/config.local.json`，权限 0600，使用私有原子替换，拒绝符号链接；此文件在本项目被忽略追踪。在其他 Git 工作区使用时也应忽略该路径。密钥不会出现在进程参数或 bridge 日志中。外部 `EVE_API_KEY` / `EVE_CONFIG` 仍遵循原配置优先级。

Swift Process 直接运行固定 Node 和固定 bridge 文件。stdin/stdout JSONL 使用 requestID，操作 allowlist、参数与 256 KiB 输入上限；事件只投影类型、工具名和状态，不发送 arguments、工具正文、完整 history、headers 或原始配置。字符串递归脱敏包括模型回显密钥。stderr 被排空但不渲染。

宿主持有规范化 workspace，操作串行；busy/cancel 可在运行期间读取/提交。原生界面在任务期间禁止切换工作区和会话。取消通过 AbortController 请求，等待核心落盘与锁释放后恢复操作；不会杀掉写入进程伪称回滚。EOF 会请求取消并等待收尾。输出排队处理管道背压；异常退出和协议错误在 UI 明确显示。运行中退出应用会提示先取消并等待。

## 验收证据

实现及验证结果将在真实模型和 UI 检查后补入本节。首个 bridge 提交 `dbf5326` 推送后：原 61 项测试加 5 项 bridge 测试（66/66）、原语法检查与 11 项 PTY 检查通过。后续新增完整进化 API 测试覆盖评分、发布、回滚、自动进化和压缩，不以按钮存在代替业务验证。
