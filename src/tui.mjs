import { TOOL_SCHEMAS } from './tools.mjs';
import readline from 'node:readline';
import { loadConfig, redactConfig, redact, setLocalConfig } from './config.mjs';
import { discoverSkills } from './skills.mjs';
import { runSession, listSessions, loadSession, newSessionId, compactSession, sessionStatus } from './sessions.mjs';

export async function startTui({ cwd, config }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('TUI 需要交互终端；脚本请使用 run --prompt ... --json');
  const color = process.env.NO_COLOR ? (_c, s) => s : (c, s) => `\x1b[${c}m${s}\x1b[0m`;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 50, removeHistoryDuplicates: true });
  let sessionId = newSessionId(), controller = null;
  const print = text => process.stdout.write(redact(text, config) + '\n');
  const header = () => {
    print(color('1;36', 'eve  /  agent PoC'));
    print(`workspace  ${cwd}\nmodel      ${config.model}\nbudget     ${config.maxSteps} steps · ${config.maxToolCalls} tools · ${config.timeoutMs / 1000}s`);
    print(color('2', '/help · /tools · /compact · /status · /skills · /config · /sessions · /resume ID · /new · /exit   Ctrl+C: cancel / quit'));
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
        if (input === '/help') print('输入任务开始执行。\n/tools  工具能力\n/status  会话、预算和摘要\n/compact  压缩当前上下文（最多一次摘要请求，原始记录保留）\n/skills  列出已发现技能\n/config  查看脱敏配置\n/config set <key> <value>  写入本地配置并重开会话\n/sessions  列出持久会话\n/resume ID  恢复会话上下文（不重放工具）\n/new  创建新持久会话\n/exit  退出\n工具仅限 workspace 文件操作；本版不执行 shell。');
        else if (input === '/tools') print(TOOL_SCHEMAS.map(t => `${t.function.name}: ${t.function.description}`).join('\n'));
        else if (input === '/status') print(JSON.stringify(await sessionStatus(cwd, sessionId, config), null, 2));
        else if (input === '/compact') {
          controller = new AbortController();
          const result = await compactSession({ cwd, config, sessionId, signal: controller.signal }); controller = null;
          print(result.status === 'completed' ? result.final : result.error?.message);
          print(JSON.stringify(await sessionStatus(cwd, sessionId, config), null, 2));
        }
        else if (input === '/new') { sessionId = newSessionId(); print(`已开始新会话。${sessionId}`); }
        else if (input === '/sessions') print(JSON.stringify(await listSessions(cwd), null, 2));
        else if (input.startsWith('/resume ')) {
          const id = input.slice(8).trim(); await loadSession(cwd, id); sessionId = id;
          print(`已恢复会话 ${sessionId}；中断工具不会自动重放。`);
        }
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
          config = await loadConfig({ cwd }); sessionId = newSessionId();
          print('已保存本地配置；会话已重置。环境变量优先级高于文件配置。');
        } else if (input.startsWith('/')) throw new Error('未知命令，输入 /help 查看');
        else {
          controller = new AbortController();
          const result = await runSession({ cwd, config, prompt: input, sessionId, signal: controller.signal,
            onEvent: e => {
              if (e.type === 'skills_discovered') print(color('2', `  skills: ${e.skills.join(', ') || 'none'}`));
              if (e.type === 'context_summary') print(`  context ${e.chars}/${e.maxChars} chars · summary ${e.method}${e.fallback ? ' (fallback)' : ''} · ${e.sourceCount} source messages`);
              if (e.type === 'model_start') print(color('2', `  thinking · step ${e.step}/${config.maxSteps}`));
              if (e.type === 'tool_start') print(color('33', `  → ${e.name}`));
              if (e.type === 'tool_end') print(color(e.ok ? '32' : '31', `  ${e.ok ? '✓' : '×'} ${e.name}${e.skill ? ` · ${e.skill} · injected ${e.injectedChars} chars` : ''}${e.error ? ` · ${e.error}` : ''}`));
            } });
          controller = null;
          if (result.status === 'completed') { print('\n' + result.final); }
          else print(color('31', `\n${result.status}: ${result.error?.message || '运行失败'}\n本轮证据已保存；已产生的文件写入不会自动撤回。`));
          print(color('2', `  session ${sessionId} · acceptance ${result.verification.status} · ${result.stats.modelRequests} requests · ${result.stats.toolCalls} tools · ${result.stats.promptTokens + result.stats.completionTokens} tokens · ${(result.stats.elapsedMs / 1000).toFixed(1)}s`));
        }
      } catch (e) { controller = null; print(color('31', `错误：${e.message}`)); }
      rl.prompt();
    }
  } finally { controller?.abort(); rl.close(); process.stdout.write('\n'); }
}
