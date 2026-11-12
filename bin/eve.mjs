#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadConfig, redactConfig, redact, DEFAULTS, setLocalConfig } from '../src/config.mjs';
import { discoverSkills } from '../src/skills.mjs';
import { runAgent } from '../src/agent.mjs';
import { startTui } from '../src/tui.mjs';

const help = `eve — local workspace agent PoC\n\n  npm start                              交互 TUI\n  npm run eve -- run --prompt "任务"      单次运行\n  npm run eve -- run --prompt "任务" --json\n  npm run eve -- skills                  技能列表\n  npm run eve -- config show             查看脱敏配置\n  npm run eve -- config init             创建无密钥本地配置\n  npm run eve -- config set model NAME   设置本地配置\n\n全局选项：--cwd DIR  --model NAME  --base-url URL\n密钥仅通过 EVE_API_KEY 或 .eve/config.local.json 提供。\n`;
function parse(argv) {
  const positional = [], options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (['--json', '--help'].includes(arg)) { options[arg.slice(2)] = true; continue; }
    if (!['--cwd', '--model', '--base-url', '--prompt'].includes(arg)) throw new Error('未知命令行选项');
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
  if (command === 'config') {
    if (!p[1] || p[1] === 'show') print(redactConfig(config));
    else if (p[1] === 'set') { if (!p[2] || p[3] === undefined) throw new Error('用法：config set KEY VALUE'); await setLocalConfig(cwd, p[2], p[3]); print('本地配置已保存；环境变量仍有更高优先级。'); }
    else if (p[1] === 'init') {
      const dir = path.join(cwd, '.eve'); await fs.mkdir(dir, { recursive: true });
      const { apiKey, ...safe } = DEFAULTS;
      await fs.writeFile(path.join(dir, 'config.local.json'), JSON.stringify(safe, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      print('已创建 .eve/config.local.json（不含密钥）。');
    } else throw new Error('未知 config 子命令');
  } else if (command === 'skills') {
    const d = await discoverSkills(cwd, config);
    print({ skills: [...d.skills.values()].map(({ name, description, hash }) => ({ name, description, hash })), warnings: d.warnings });
  } else if (command === 'run') {
    if (!o.prompt) throw new Error('run 需要 --prompt');
    const controller = new AbortController();
    const abort = () => controller.abort(); process.on('SIGINT', abort);
    try {
      const r = await runAgent({ cwd, config, prompt: o.prompt, signal: controller.signal,
        onEvent: e => { if (!o.json && ['model_start', 'tool_start', 'tool_end'].includes(e.type)) process.stderr.write(redact(`[${e.type}] ${e.name || `step ${e.step}`}${e.ok === false ? ' failed' : ''}\n`, config)); } });
      const { messages, ...output } = r;
      print(o.json ? output : r.status === 'completed' ? r.final : `${r.status}: ${r.error?.message}`);
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
