# Agent 自进化修复与最终验收

本记录对应 2026-11-13 UTC 的实际运行。起点为 `0926f12497f487085744efe11ea134b8c746ea12`，唯一写者为本轮实现者，没有派其他 agent。原有断言未修改或降低，新增确定性顺序与文件系统故障回归。作者自行审查，不能称为新增独立 reviewer 验收。

## 源码、推送与证据口径

修复源码提交：`9f405c5130b4e6f3fe6c4764f58ee0ac48c5e68e`。

先执行 `git push git@github.com:luckyscript/eve.git main:main`，再执行下列完整回归。推送未 force、未修改 origin（仍为原来的 HTTPS 地址）；`git ls-remote git@github.com:luckyscript/eve.git refs/heads/main` 与本地 HEAD 一致。agent/evolution 报告均记录运行前后 HEAD 相同、dirty=false、源码总 fingerprint 相同。

源码总 SHA-256：`3adcfac13c6aca412a7e3ec40c0eb513e31bceb99811a7c0a41a414d366ee92a`。算法见 `scripts/verification-evidence.mjs`：对 git 跟踪的 src/bin/scripts/skills/test/package 文件排序，逐文件 SHA-256，再对路径→digest 的 JSON 取 SHA-256。文档不在这个集合中；报告包含完整逐文件列表。

| 关键文件 | SHA-256 |
| --- | --- |
| src/agent.mjs | b40bb95fdf8a15f185ba795144befa5bf70840c7850a20cb9d0712822ba2d376 |
| src/evolution.mjs | 79b1aa77150dd9564fa90afe71f1702f948e9e6caaac91f5b7bb4e6446688ca9 |
| src/registry.mjs | 79eb9073de9f74fe4a0ac75d12872c8614a5c6d193bdcb3e15f6fdaaf958300f |
| scripts/verify-agent.mjs | f460ec41011c766892425c0a2cdff17119e65972845d123e7ecad2d1e31ad7bf |
| scripts/verify-evolution.mjs | fa00a3001123575df0e553a57c4045dc2f5aad54520c8ad8980109712d684928 |

本文件单独作为文档提交推送。收尾时再次执行 test/check/PTY，并把该文档提交 SHA、SSH 远端 SHA、源码 fingerprint 与实际退出码保存到 ignored `.eve/runs/final-local.json`。最终答复给出该提交 SHA。以源码 fingerprint 不变来关联上述真实模型结果，不将源码提交的 live 结果伪称为文档提交上重新运行的 live。

历史记录纠正：原进化实现的 **55 calls** 演示发生于 feature commit 前的工作树，未记录 source HEAD 或源码 digest，不能证明 postpush 同源验收。本轮已在 `docs/superpowers/plans/2026-11-13-evolution.md` 明确标为 historical precommit，不补造历史 SHA。下述 **56 calls** 是本轮推送之后重新执行的真实进化。

## 三个缺陷的修复证据

P1：在通用 `runAgent(requiredSkillHash)` 模式，对所有非 `load_skill` 工具实施同一门禁，包括 read/list/search/write/edit 及未来新增 task 工具。每次模型请求从实际 request messages 中核对成功 load 的 hash 和完整正文，记录 `loadedSkillHashes`、request digest、step；工具意图关联到生成该调用参数的那次请求。加载同批后续工具不会借用刚加载的 hash。顺序违规发出 `skill_order_violation` 并以 `SKILL_ORDER` 停止，不能生成收益证据。

两条评测 arm 都传入各自的 required hash，使用相同配置、预算、工具和规则。提示明确先单独 load 并等待下一模型请求；没有宿主预加载捷径。评测还要求 ordered=true：存在携带正文的后续模型请求，所有 task intent 的请求均携带正确 hash，且没有顺序违规。生成器依然只收到公开 source task、失败类别、公开 correction、旧技能，不收到隐藏 suite、contract 或历史逐题结果。

确定性 mock 模型回归覆盖：先写再 load、同批 load+write、先读再 load、先 edit 再 load 均拒绝且文件不变；load→后续模型请求→write 合法且 trace 携带 hash。已有隐藏 canary 排除测试保留。首轮新增 7 项测试全部观察到预期红灯；修复后通过。targeted 最终为 26/26（evolution 25 + request audit 1）。

P2 发布后记录 EIO：registry `state.json` 的原子 rename 是发布 commit 点。promote 后保存 `experiment.status=promoted` 失败时读取 registry reconcile；若候选已经 active，返回 `status:promoted`、`recording_error`、`actualActiveHash`。再次记录失败也以 retryCode 披露，不把它静默吞掉并称普通 failed。测试通过真实文件系统执行、在保存 promoted experiment 的 rename 注入 EIO，核验返回值和实际 active 一致。私有 experiment 文件可能仍停留 evaluated；此时 registry 与返回的 recording_error 是必须检查的真相。

P2 取消窗口：保存 evaluated 后、调用 promote 前执行 combined.throwIfAborted；signal 继续进入 registry 跨进程锁，在锁内更新前、事务写入前及 staging fsync 完成后的 rename 前检查。测试模拟 evaluated 保存后 abort、锁内读取评测后 abort、state 暂存 sync 后 abort，均不改变 active。rename 已提交后取消不撤销已发布状态；之后记录异常按 registry 实际指针 reconcile。没有声称可以撤销已经提交给文件系统的 rename 或文件副作用。

## 推送后的实际回归

全部在上述源码提交、clean 工作树上执行。模型：`macmini-magpie/bailian-token-plan/qwen3.8-max`，使用既有 0600 本地配置，未打印 API key。请求在 transport 前保守计数，已发起后被取消的请求也保留，不声称每个请求都一定产生同样账单费用。

| 命令/阶段 | 实际结果 | 请求数（含摘要） | 时长 |
| --- | --- | ---: | ---: |
| npm test | 61/61，0 fail | 0 付费 | 30.140 秒（命令外层） |
| npm run check | 通过 | 0 | 0.626 秒 |
| npm run verify:tui | 11/11 PTY 检查通过 | 0 | 0.304 秒 |
| npm run verify:live | 9/9 checks，通过实际正文 nonce、工具、读回和 schema | 5 | 31.940 秒（agent） |
| verify:agent 首次执行 | 外层错误设为 60 秒，进程被截断；无新完成报告，不计为通过 | 12 | 60 秒外层上限 |
| npm run verify:agent 重跑 | 7/7 checks，全部通过 | 14 | 75.527 秒 |
| npm run verify:evolution | 10/10 checks，完整实际链路通过 | 56 | 246.571 秒 |

付费总预算 **100**，本轮实际审计 **87 次请求尝试**：task 84、generation 1、summary 2。成功完整验证共 75 次，另有中断的 12 次，没有漏算或超额。agent 成功重跑的 14 次包含 1 次模型摘要；中断执行也包含 1 次摘要。没有为文档收尾再发付费请求。

实际共同环境及命令如下；三条付费验证依次执行，共用同一 append-only JSONL 账本和进程间锁，超过 100 在新 transport 前拒绝：

```bash
cd /Users/kay/eve
git push git@github.com:luckyscript/eve.git main:main
git ls-remote git@github.com:luckyscript/eve.git refs/heads/main
npm test
npm run check
npm run verify:tui
export EVE_REQUEST_AUDIT=/Users/kay/eve/.eve/runs/completion-paid.jsonl
export EVE_REQUEST_LIMIT=100
npm run verify:live
npm run verify:agent
npm run verify:evolution
```

agent 成功验证从 `2026-11-13T16:28:23.264Z` 至 `2026-11-13T16:29:38.791Z`。阶段请求数：search/edit/readback 4、remember 2、bulk history 2、recent small group 2、compact 1（模型摘要）、跨进程 recall 3。真实随机事实只来自后来已删除的文件；摘要保留事实，原始账本哈希保持不变，事实未混入用户提示或 acceptance system prompt。agent suite hash：`2ea8aebcfe1dc00fe1fa02835cf566dd86e52a5a00ee53527ad742c840ce3b81`。

## 完整真实进化结果

开始 `2026-11-13T16:29:59.891Z`，结束 `2026-11-13T16:34:06.462Z`。

- suite hash：`2623a7112d0afbb5b6d00aefad8fa7bdf8bdaf01ddbb1c70d47274d336773e3c`
- baseline hash：`f1f7567a7a28fdd6d2e9a80a2a61e16fa3b3cb8a72c26af1c02afb08011688c4`
- 真实生成 candidate hash：`da730a47a8fc64c8041381095863a93639403afaa4e3a355eff9bbbd396ebaaf`
- experiment ID：`e-1d679803-8bf1-4ab0-b23e-9cd13f9efaf3`

| hidden case | baseline | candidate | 两臂顺序证据 |
| --- | --- | --- | --- |
| blank-space | failed | passed | ordered=true |
| unicode | failed | passed | ordered=true |
| duplicate-order | passed | passed | ordered=true |
| empty | failed | passed | ordered=true |

得分 **1/4 → 4/4**，baseline 已通过项无退步。56 次组成：source 5、生成 1、四例×两臂×5=40、发布后的独立新进程 5、回滚后的独立新进程 5。未用 mock 替代这个链路。

实际发布后，新进程从当前 active 加载 candidate hash，产生并读回新输入报告，契约 passed；source 产物未重放或改变。随后 rollback 恢复上述 baseline hash；磁盘产物不因回滚而撤销，另一个新进程实际加载 baseline，按新的正确契约得到预期 failed。最后创建不同内容的坏候选，没有评测，promote 实际被拒绝，active 仍为 baseline。

## CLI 功能操作参考

以下是完整功能入口参考，ID/路径/任务需换成用户自己的公开开发材料；不是声称又执行了这些额外付费任务。本轮真实多进程运行由 package 验证脚本驱动；CLI 自动进化入口、CAS、取消、保护路径等还由完整测试覆盖。

```bash
cd /Users/kay/eve
npm start
node bin/eve.mjs tools
node bin/eve.mjs skills
node bin/eve.mjs config show
node bin/eve.mjs config init
node bin/eve.mjs config set model MODEL_NAME
node bin/eve.mjs run --cwd WORKSPACE --session SESSION_ID --prompt "完成授权文件任务，使用匹配技能并读回" --json
node bin/eve.mjs sessions --cwd WORKSPACE
node bin/eve.mjs status --cwd WORKSPACE --session SESSION_ID
node bin/eve.mjs compact --cwd WORKSPACE --session SESSION_ID --json
node bin/eve.mjs run --cwd WORKSPACE --session SESSION_ID --contract .eve/contracts/task.json --prompt "按本轮任务继续，核验实际产物" --json
node bin/eve.mjs evolve import --cwd WORKSPACE --file skills/NAME/SKILL.md
node bin/eve.mjs capabilities --cwd WORKSPACE
node bin/eve.mjs evolve --cwd WORKSPACE --session SESSION_ID --run RUN_ID --skill NAME --suite .eve/suites/task.json --correction "公开的通用纠正意见" --max-requests 45 --evolution-timeout-ms 600000 --no-promote --json
node bin/eve.mjs evolve promote CANDIDATE_ID --cwd WORKSPACE --json
node bin/eve.mjs evolve rollback NAME --cwd WORKSPACE --json
node bin/eve.mjs run --cwd WORKSPACE --session SESSION_ID --contract .eve/contracts/task.json --prompt "完成授权任务" --auto-evolve --skill NAME --suite .eve/suites/task.json --correction "公开的通用纠正意见" --max-requests 45 --json
```

search_files 的 literal 搜索、唯一 exact edit_file、write/readback 是模型工具，不能伪称存在同名 shell CLI 子命令。契约 file_exists/json_equals/text_contains/write_readback/text_equals/sha256_equals、suite 格式与工具参数见 README。TUI `/help`、`/tools`、`/status`、`/skills`、`/config`、`/sessions`、`/resume`、`/compact`、`/new` 及退出由 11 项真实 PTY 检查覆盖。

## 私有证据与清理

下列全部 ignored；公开文档仅列元数据、分数和哈希，不粘贴隐藏输入、模型正文、生成技能正文或凭据。

| 证据 | SHA-256 |
| --- | --- |
| .eve/runs/evolution-verification.json | c7ef323a91e8c9dd089e745594f8326d25cb525427a5dbb825160a20d4a63118 |
| .eve/runs/agent-verification.json | 8c7149c0b44d124b2891369fbe88edd7a2fef784f183d0b3cbcc4ec5be24bc72 |
| .eve/runs/live-verification.json | b739fe7255c1c7de9fba3eb19c09dc7ba9a6ae1453d9384012dc21474275fceb |
| .eve/runs/completion-paid.jsonl | 4b0555e5348aafe4538f2562e615bb505add482af2b17c9a47e71eb755ead81f |

`.eve/runs/completion-manifest.json` 保存统计、报告 hashes、凭据扫描结果和归档映射。原始会话、generator 输入、冻结 suite、技能对象和实验账本保存在 0600 的私有归档，供本机复核，未提交 Git：

- `.eve/runs/completion-evidence/agent.tar.gz`，SHA-256 `d035938f44f6c72e6983c5f704882099038d6da5cad54569c15696db990d8527`
- `.eve/runs/completion-evidence/agent-interrupted.tar.gz`，SHA-256 `9e98eef8210a48dffc79455fb06cbdc909bd5f3147fa7a9df02a41aafd19f4d2`
- `.eve/runs/completion-evidence/evolution.tar.gz`，SHA-256 `b6ce8d98fc8cc7f4ce5aacad044b14a7cae4a0226cddc2e792d9900aacfde3f0`

归档后已删除本轮三个原始临时 workspace；报告中原 workspace 路径可经 manifest 映射到归档内。临时复制的认证配置在归档前已删除，原本地配置维持 0600。跟踪文件与 Git 全历史均做凭据特征和当前本地 API key 的精确匹配扫描，通过；不输出 key。`.eve/config.local.json`、runs、sessions、evolution、verify-* 和 .env 均受现有 ignore 保护。收尾远端 SHA、工作区清洁与最后本地检查以 final-local.json 和最终答复为准。

## 已知边界

本次验收完成的是**局部技能文本进化**：小样本可复核证据，不能外推为通用能力、自主安全性或跨任务分布的保证。baseline 导入仍是 trusted user 操作；没有自动生成代码或扩大工具权限。

上下文是可配置的**字符 budget**，不是精确 token 预算。摘要可损失信息；摘要调用共享模型请求预算。原始账本保留，但不等于模型能永久记住所有事实。paid audit 统计 transport 尝试，不提供货币费用估算。

恢复发生在**任务边界**：未决工具结果为 unknown，不自动重放。不是任意工具中间点无损恢复，也不是 exactly-once；已经发起的文件 I/O 必须核验实际状态。rollback 只撤回未来任务使用的技能，不撤销产物或其他副作用。

工作区路径、符号链接、技能和 registry 保护属于宿主工具策略，**没有 OS 沙箱**，不抵御有本机权限的恶意进程或直接篡改私有文件。发布 lock 遗留时保守拒绝，需检查写者；不是多主机分布式事务。
