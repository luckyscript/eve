# 持久任务会话与独立结果验收：真实验证记录

日期：2026-11-13。基线：2255fc81d316076ec651471496999e9912293031，开始时 HEAD 匹配、工作区干净。仅本轮实现者写入，未派其他 agent；原有研究方案与 PoC 历史验证记录未修改。

## 交付与提交前定向检查

Node 原生 ESM、零依赖。新增 sessions/contracts 模块，接入原有 loop、CLI 和 TUI。会话账本支持私有原子保存、跨进程写者锁、死进程锁回收、任务边界续聊。工具副作用前记录意图，结果独立落盘；中断运行 interrupted、未决结果 unknown，未派发工具 not_executed。不自动重放写入。截断响应单独保留在 responses，不进入可执行消息历史。

`node --test test/sessions.test.mjs`：9/9 通过，约 1.46 秒；新增行为测试先观察到缺失功能/错误断言失败，再修正实现。覆盖：

1. 文件存在、JSON 字段等值、文本包含、独立文件读回与不安全 assertion 拒绝。
2. 严格 ID、文件 0600、原子 save/load、同进程写者排斥。
3. 真正独立 CLI 进程续聊、多工具原始历史、错误产物拒绝、CLI 不输出测试认证值。
4. 强杀持锁子进程，恢复 interrupted/unknown，修复派生 tool 协议，不重放写入。
5. load_skill 不可读取 .eve，符号链接状态目录拒绝且不写入目标。
6. 跨进程活锁排斥、孤立临时文件不影响加载、损坏账本保留原字节且拒绝覆盖。
7. 失败工具批次完整消息、预算未派发记录、失败后继续、成功写入的独立 SHA-256 读回验收。
8. 真正 runSession 在第二个工具执行前 SIGKILL：首个产物保留、后一个意图 unknown 且无产物。
9. 截断模型工具响应保留原始证据，不进入 executable history、不产生写入。

对修改的入口/运行模块、新验证脚本运行 `node --check`，通过；`git diff --check` 通过。完整 npm 回归按用户要求仅在 feature 推送后执行，结果随后记录。

## 已有本地配置的真实模型验证

执行：`node scripts/verify-sessions-live.mjs`（也可 `npm run verify:sessions-live`）。使用现有本地配置的 OpenAI-compatible 服务，没有打印认证，没有替换为假模型。验证在 ignored 隔离 workspace 运行；三个独立 CLI 进程使用真实模型响应与实际文件产物。

最终实测开始时间：2026-11-13T15:27:40.322Z。退出码 0，`passed: true`。5/5 断言通过：首轮产物通过、跨进程续聊产物通过、错误产物被拒绝、完整历史持久化、模型写后实际 read_file。此后仅增补了失败截断响应的原始证据检查点，该补充分别由定向测试和 postpush 回归覆盖。

| 场景 | 模型状态 | 验收 | CLI 退出码 | 模型请求 | 工具调用 | 运行耗时 |
|---|---|---|---:|---:|---:|---:|
| 首轮创建随机 nonce 的 JSON | completed | passed | 0 | 3 | 2 | 11727 ms |
| 新进程从历史取回相同 nonce 并生成新文件 | completed | passed | 0 | 4 | 3 | 21418 ms |
| 模型回答已完成，但现存 JSON 的 answer 为 0、契约要求 42 | completed | failed | 1 | 1 | 0 | 2650 ms |

续聊提示未重传 nonce，输出必须与首轮随机值一致；独立宿主读回 JSON 和写入字节 SHA-256，不依据模型自述打分。首轮及续聊使用同一 session，错误产物场景使用另一个 session。摘要位于 ignored `.eve/runs/session-verification.json`，私有账本保留在相应隔离 workspace 的 `.eve/sessions/`；复制的认证文件在 finally 清除。

该验证证明一次真实链路；不能据此保证任意模型任务成功。

## 审查结论与后续接口

依用户要求由作者自行审查，没有独立 reviewer。已修复发现的 .eve 技能加载旁路、空会话读取时多余改写、预算拒派发记录缺失、截断响应证据缺失；均有针对测试。未将研究方案中的 SQLite/Pi/进化 worker 提前引入本功能。

未来由宿主读取 loadSession/listSessions 返回的 runs：失败 status/error/verification、contract 定义、capabilitySnapshot、responses/messages/events 与 tools 的意图和结果。先导出脱敏反例，再在隔离 workspace 生成/评测候选；不得将修复会话历史等同于执行恢复，也不得由生成器修改验收门槛。本功能不会自动生成技能、评测晋级或改变能力发布状态。

已知边界：整账本替换开销随历史增长；没有自动上下文压缩或产物回滚。锁基于本机 PID，PID 重用时保守拒绝；回收者自身崩溃留下的 .lock.reap 需人工确认。不同 session 不锁共享产物。文件路径约束不是防恶意并发换路径的 OS 沙箱。没有 exactly-once 或进程中间点无损恢复承诺。

## 推送后完整回归

Feature 提交 `334f64f`，使用 `git push git@github.com:luckyscript/eve.git main:main` 成功推送，无 force、未改远程。

首次 postpush `npm test` 为 18/19：原有第 4 项技能注入测试失败，因此 `&&` 后的 check / verify:tui 未执行。根因是 load_skill 对绝对路径中所有 `.eve` 片段进行保护，误伤 workspace 祖先中的 `.eve/verify-test-*`；修正为检查相对 workspace 的路径片段，仍阻止 workspace 内 `.eve` 的访问。新增第 10 项针对测试先复现失败，再验证修复；不修改旧测试。修复提交推送后重新执行完整三项回归，结果随后补记。


修复提交：`5e4923c3ec22bc53a2dbba3d3417897bb43004ee`。指定 SSH 地址推送成功后执行：

```text
npm test            exit 0 · 20/20 通过（原有 10 项 + 新增 10 项）· 约 1.47 秒
npm run check       exit 0 · 全部 10 个运行模块/脚本语法通过
npm run verify:tui  exit 0 · passed:true · 8/8 PTY 检查通过
```

TUI 覆盖：真实终端启动、help、skills、脱敏 config、sessions、resume、新会话、正常退出。测试创建的会话 fixture 在 finally 清理。此项仍是命令冒烟，不声称覆盖 TUI 中真实模型取消的端到端行为。

2026-11-13T15:32:08Z 读取 SSH `ls-remote refs/heads/main`，与本地 HEAD 均为 `5e4923c3ec22bc53a2dbba3d3417897bb43004ee`，当时工作区干净。本记录的随后文档提交也按相同顺序推送后再次完整回归，最终 SHA 与结果由交付回复给出。

提交前仅 stage 明确文件，扫描配置中实际认证字符串和常见私钥/GitHub token 标记，不输出值。Feature 的 14 个 staged 文件没有独立凭据命中；README 一处命中属于基线已公开的模型名片段（对照基线确认），单独排除，不作为凭据。修复的 3 个 staged 文件也没有认证字符串命中。完整私有历史与模型验证目录未被提交，未修改 origin URL、未 force push。
