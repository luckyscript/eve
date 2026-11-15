#!/usr/bin/env node
import { remoteCLI } from '../src/remote-cli.mjs';
import { TOOL_SCHEMAS } from '../src/tools.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadConfig, redactConfig, redact, DEFAULTS, setLocalConfig } from '../src/config.mjs';
import { discoverSkills } from '../src/skills.mjs';
import { runSession, listSessions, compactSession, sessionStatus } from '../src/sessions.mjs';
import { startTui } from '../src/tui.mjs';
import { capabilities, importBaseline, promote, rollback } from '../src/registry.mjs';
import { prepareAutoEvolution } from '../src/orchestration.mjs';
import { evolve, autoEvolve, freezeSuite } from '../src/evolution.mjs';

const help = `eve — local workspace agent PoC\n\n  npm start                              交互 TUI\n  npm run eve -- run --prompt "任务"      单次运行\n  npm run eve -- run --prompt "任务" --json\n  npm run eve -- sessions                持久会话列表\n  npm run eve -- run --session ID --contract FILE --prompt \"任务\"\n  npm run eve -- tools                   工具能力（无 shell/exec）\n  npm run eve -- status --session ID      上下文预算和摘要状态\n  npm run eve -- compact --session ID     手动压缩，保留原始会话\n  npm run eve -- skills                  技能列表\n  npm run eve -- capabilities            发布能力与候选状态\n  npm run eve -- evolve import --file skills/NAME/SKILL.md\n  npm run eve -- evolve --session ID --run RUNID --skill NAME --suite FILE --max-requests 45\n  npm run eve -- evolve promote ID        发布已通过评测的候选\n  npm run eve -- evolve rollback NAME     撤回版本，下一任务生效\n  run --auto-evolve --skill NAME --suite FILE --max-requests N（需要 --contract）\n  npm run eve -- config show             查看脱敏配置\n  npm run eve -- config init             创建无密钥本地配置\n  npm run eve -- config set model NAME   设置本地配置\n  eve remote enable --relay-url HTTPS_URL --name NAME\n  eve remote start                     前台中继连接\n  eve remote pair                      显式输出私密配对链接\n  eve remote status                    连接和配对状态\n  eve remote revoke PAIR_ID             撤销手机授权\n  eve remote configure --file FILE      本地权限和注册配置\n  eve remote disable                   关闭远程访问\n\n全局选项：--cwd DIR  --model NAME  --base-url URL\n密钥仅通过 EVE_API_KEY 或 .eve/config.local.json 提供。\n`;
function parse(argv) {
  const positional = [], options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (['--json', '--help', '--auto-evolve', '--no-promote', '--dev-loopback'].includes(arg)) { options[arg.slice(2)] = true; continue; }
    if (!['--cwd', '--model', '--base-url', '--prompt', '--session', '--contract', '--run', '--skill', '--suite', '--correction', '--max-requests', '--evolution-timeout-ms', '--file', '--relay-url', '--name'].includes(arg)) throw new Error('未知命令行选项');
    if (!argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`${arg} 缺少值`);
    options[arg.slice(2)] = argv[++i];
  }
  return { positional, options };
}
let config;
try {
  const { positional: p, options: o } = parse(process.argv.slice(2));
  if (o.help || p[0] === 'help') { console.log(help); process.exit(0); }
  const cwd = await fs.realpath(path.resolve(o.cwd || process.cwd()));
  const overrides = { ...(o.model ? { model: o.model } : {}), ...(o['base-url'] ? { baseUrl: o['base-url'] } : {}) };
  config = await loadConfig({ cwd, overrides });
  const print = value => console.log(redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2), config));
  const command = p[0] || 'tui';
  if (command === 'remote') {
    await remoteCLI(cwd, p[1], o, p.slice(2));
  } else if (command === 'config') {
    if (!p[1] || p[1] === 'show') print(redactConfig(config));
    else if (p[1] === 'set') { if (!p[2] || p[3] === undefined) throw new Error('用法：config set KEY VALUE'); await setLocalConfig(cwd, p[2], p[3]); print('本地配置已保存；环境变量仍有更高优先级。'); }
    else if (p[1] === 'init') {
      const dir = path.join(cwd, '.eve'); await fs.mkdir(dir, { recursive: true });
      const { apiKey, ...safe } = DEFAULTS;
      await fs.writeFile(path.join(dir, 'config.local.json'), JSON.stringify(safe, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      print('已创建 .eve/config.local.json（不含密钥）。');
    } else throw new Error('未知 config 子命令');
  } else if (command === 'tools') {
    print(TOOL_SCHEMAS);
  } else if (command === 'status') {
    if (!o.session) throw new Error('status 需要 --session ID');
    print(await sessionStatus(cwd, o.session, config));
  } else if (command === 'compact') {
    if (!o.session) throw new Error('compact 需要 --session ID');
    const { messages, context, ...result } = await compactSession({ cwd, config, sessionId: o.session });
    print({ ...result, context: await sessionStatus(cwd, o.session, config) });
    if (result.status !== 'completed') process.exitCode = 1;
  } else if (command === 'skills') {
    const d = await discoverSkills(cwd, config);
    print({ skills: [...d.skills.values()].map(({ name, description, hash }) => ({ name, description, hash })), warnings: d.warnings });
  } else if (command === 'sessions') {
    print(await listSessions(cwd));
  } else if (command === 'capabilities') {
    print(await capabilities(cwd));
  } else if (command === 'evolve') {
    if (p[1] === 'import') {
      if (!o.file) throw new Error('evolve import 需要 --file SKILL.md（trusted user baseline）');
      print(await importBaseline(cwd, o.file));
    } else if (p[1] === 'promote') print(await promote(cwd, p[2]));
    else if (p[1] === 'rollback') print(await rollback(cwd, p[2]));
    else if (p[1]) throw new Error('未知 evolve 子命令');
    else {
      const r = await evolve({ cwd, config, sessionId: o.session, runId: o.run, skill: o.skill, suiteFile: o.suite, correction: o.correction, maxRequests: Number(o['max-requests']), timeoutMs: o['evolution-timeout-ms'] ? Number(o['evolution-timeout-ms']) : undefined, autoPromote: !o['no-promote'] });
      const { evaluation, ...summary } = r;
      print({ ...summary, evaluation: { status: evaluation.status, cases: evaluation.cases.map(c => ({ id: c.id, baseline: c.baseline.passed, candidate: c.candidate.passed })), limitation: evaluation.limitation } });
      if (!['promoted', 'evaluated'].includes(r.status)) process.exitCode = 1;
    }
  } else if (command === 'run') {
    let frozenSuite;
    if (o['auto-evolve']) {
      frozenSuite = await prepareAutoEvolution({ cwd, contractFile: o.contract, skill: o.skill, suiteFile: o.suite, maxRequests: Number(o['max-requests']) });
    }
    if (!o.prompt) throw new Error('run 需要 --prompt');
    const controller = new AbortController();
    const abort = () => controller.abort(); process.on('SIGINT', abort);
    try {
      const r = await runSession({ cwd, config, prompt: o.prompt, sessionId: o.session, contractFile: o.contract, signal: controller.signal,
        onEvent: e => { if (!o.json && ['model_start', 'tool_start', 'tool_end'].includes(e.type)) process.stderr.write(redact(`[${e.type}] ${e.name || `step ${e.step}`}${e.ok === false ? ' failed' : ''}\n`, config)); } });
      if (o['auto-evolve']) {
        try {
          r.evolution = await autoEvolve({ result: r, cwd, config, frozenSuite, skill: o.skill, suiteFile: o.suite, correction: o.correction, maxRequests: Number(o['max-requests']), timeoutMs: o['evolution-timeout-ms'] ? Number(o['evolution-timeout-ms']) : undefined, signal: controller.signal });
          if (r.evolution.evaluation) r.evolution = { status: r.evolution.status, experimentId: r.evolution.experimentId, candidate: r.evolution.candidate, evaluationHash: r.evolution.evaluationHash, nextTaskOnly: true };
        } catch (e) { r.evolution = { status: 'failed', error: redact(e.message, config), nextTaskOnly: true }; }
      }
      const { messages, context, ...output } = r;
      output.context = await sessionStatus(cwd, r.sessionId, config);
      print(o.json ? output : `session: ${r.sessionId} · ${r.status} · acceptance: ${r.verification.status}\n${r.status === 'completed' ? r.final : r.error?.message}${r.evolution ? `\nevolution: ${r.evolution.status} · next task only` : ''}`);
      if (r.status !== 'completed') process.exitCode = 1;
    } finally { process.removeListener('SIGINT', abort); }
  } else if (command === 'tui') await startTui({ cwd, config });
  else throw new Error('未知命令，使用 --help');
} catch (e) {
  const isJson = process.argv.includes('--json');
  // Configuration parsing errors deliberately avoid including file contents.
  const message = redact(e.message, config);
  if (isJson) console.log(JSON.stringify({ status: 'failed', error: { code: 'CLI', message } }));
  else console.error(message);
  process.exitCode = 1;
}
