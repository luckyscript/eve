import readline from 'node:readline';
import { loadConfig, redactConfig, redact, setLocalConfig } from './config.mjs';
import { discoverSkills } from './skills.mjs';
import { runAgent } from './agent.mjs';

export async function startTui({ cwd, config }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('TUI 需要交互终端；脚本请使用 run --prompt ... --json');
  const color = process.env.NO_COLOR ? (_c, s) => s : (c, s) => `\x1b[${c}m${s}\x1b[0m`;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 50, removeHistoryDuplicates: true });
  let history = [], controller = null;
  const print = text => process.stdout.write(redact(text, config) + '\n');
  const header = () => {
    print(color('1;36', 'eve  /  agent PoC'));
    print(`workspace  ${cwd}\nmodel      ${config.model}\nbudget     ${config.maxSteps} steps · ${config.maxToolCalls} tools · ${config.timeoutMs / 1000}s`);
    print(color('2', '/help · /skills · /config · /new · /exit   Ctrl+C: cancel / quit'));
  };
  rl.on('SIGINT', () => {
    if (controller) { controller.abort(); print('\n取消中…'); }
    else rl.close();
  });
  header();
  rl.setPrompt(color('1;36', '\neve › '));
  rl.prompt();
  try {
    for await (const raw of rl) {
      const input = raw.trim();
      if (!input) { rl.prompt(); continue; }
      if (input === '/exit' || input === '/quit') break;
      try {
        if (input === '/help') print('输入任务开始执行。\n/skills  列出已发现技能\n/config  查看脱敏配置\n/config set <key> <value>  写入本地配置并重开会话\n/new  清空内存会话\n/exit  退出\n工具仅限 workspace 文件操作；本版不执行 shell。');
        else if (input === '/new') { history = []; print('已开始新会话。'); }
        else if (input === '/skills') {
          const d = await discoverSkills(cwd, config);
          for (const s of d.skills.values()) print(`${color('36', s.name)}  ${s.description}`);
          if (!d.skills.size) print('没有发现技能。');
          for (const w of d.warnings) print(`提示：${w}`);
        } else if (input === '/config') print(JSON.stringify(redactConfig(config), null, 2));
        else if (input.startsWith('/config set ')) {
          const m = input.match(/^\/config set (\S+)\s+([\s\S]+)$/);
          if (!m) throw new Error('用法：/config set <key> <value>');
          await setLocalConfig(cwd, m[1], m[2]);
          config = await loadConfig({ cwd }); history = [];
          print('已保存本地配置；会话已重置。环境变量优先级高于文件配置。');
        } else if (input.startsWith('/')) throw new Error('未知命令，输入 /help 查看');
        else {
          controller = new AbortController();
          const result = await runAgent({ cwd, config, prompt: input, history, signal: controller.signal,
            onEvent: e => {
              if (e.type === 'skills_discovered') print(color('2', `  skills: ${e.skills.join(', ') || 'none'}`));
              if (e.type === 'model_start') print(color('2', `  thinking · step ${e.step}/${config.maxSteps}`));
              if (e.type === 'tool_start') print(color('33', `  → ${e.name}`));
              if (e.type === 'tool_end') print(color(e.ok ? '32' : '31', `  ${e.ok ? '✓' : '×'} ${e.name}${e.skill ? ` · ${e.skill} · injected ${e.injectedChars} chars` : ''}${e.error ? ` · ${e.error}` : ''}`));
            } });
          controller = null;
          if (result.status === 'completed') { history = result.messages; print('\n' + result.final); }
          else print(color('31', `\n${result.status}: ${result.error?.message || '运行失败'}\n本轮不加入会话；已产生的文件写入不会自动撤回。`));
          print(color('2', `  ${result.stats.modelRequests} requests · ${result.stats.toolCalls} tools · ${result.stats.promptTokens + result.stats.completionTokens} tokens · ${(result.stats.elapsedMs / 1000).toFixed(1)}s`));
        }
      } catch (e) { controller = null; print(color('31', `错误：${e.message}`)); }
      rl.prompt();
    }
  } finally { controller?.abort(); rl.close(); process.stdout.write('\n'); }
}
