import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function workspace(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-session-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}
const sessionsUrl = pathToFileURL(path.resolve('src/sessions.mjs'));
const contractsUrl = pathToFileURL(path.resolve('src/contracts.mjs'));

test('contract: independent readback rejects wrong artifacts and unsafe assertions', async t => {
  const { validateContract, verifyContract } = await import(contractsUrl);
  const cwd = await workspace(t);
  const contract = validateContract({ version: 1, assertions: [
    { type: 'file_exists', path: 'result.json' },
    { type: 'json_equals', path: 'result.json', field: ['answer'], value: 42 },
    { type: 'text_contains', path: 'result.json', text: 'answer' },
  ] });
  await fs.writeFile(path.join(cwd, 'result.json'), '{"answer":0}');
  assert.equal((await verifyContract(cwd, contract)).status, 'failed');
  await fs.writeFile(path.join(cwd, 'result.json'), '{"answer":42}');
  assert.equal((await verifyContract(cwd, contract)).status, 'passed');
  for (const p of ['../escape', '/tmp/escape', '.eve/private', '.env', 'foo/../../x']) {
    await assert.rejects(verifyContract(cwd, validateContract({ version: 1, assertions: [{ type: 'file_exists', path: p }] })), /路径|workspace|配置/);
  }
  await fs.symlink(path.join(cwd, 'result.json'), path.join(cwd, 'link'));
  await assert.rejects(verifyContract(cwd, { version: 1, assertions: [{ type: 'file_exists', path: 'link' }] }), /符号链接/);
  assert.throws(() => validateContract({ version: 1, assertions: [{ type: 'js', code: 'true' }] }));
});

test('session: private atomic save/load, writer lock and strict IDs', async t => {
  const { openSession, loadSession, listSessions } = await import(sessionsUrl);
  const cwd = await workspace(t);
  for (const id of ['../x', '.', '', '/tmp/x', 'a/b', 'a\\b', 'a'.repeat(65)]) await assert.rejects(openSession(cwd, id));
  const s = await openSession(cwd, 'task-1');
  await assert.rejects(openSession(cwd, 'task-1'), /锁|占用/);
  s.data.runs.push({ id: 'run-1', status: 'completed', messages: [{ role: 'user', content: 'evidence' }], events: [] });
  await s.save(); await s.close();
  assert.equal((await loadSession(cwd, 'task-1')).runs[0].messages[0].content, 'evidence');
  assert.equal((await fs.stat(path.join(cwd, '.eve/sessions/task-1.json'))).mode & 0o777, 0o600);
  assert.equal((await listSessions(cwd))[0].id, 'task-1');
});

const cli = path.resolve('bin/eve.mjs');
const response = message => ({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function cliRun(cwd, args, env = {}) {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, '--cwd', cwd, ...args], { env: { ...process.env, EVE_API_KEY: 'private-probe-key', ...env } });
    let stdout = '', stderr = '';
    p.stdout.on('data', b => stdout += b); p.stderr.on('data', b => stderr += b);
    p.on('error', reject); p.on('close', code => resolve({ code, stdout, stderr }));
  });
}
async function server(t, answer) {
  const { createServer } = await import('node:http');
  const s = createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    try { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await answer(JSON.parse(body)))); }
    catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); }));
  return { EVE_BASE_URL: `http://127.0.0.1:${s.address().port}/v1`, EVE_MAX_STEPS: '8' };
}

test('CLI: separate processes continue full multi-tool history and independently reject incorrect output', async t => {
  const { loadSession } = await import(sessionsUrl);
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'input.txt'), 'private-probe-key');
  await fs.writeFile(path.join(cwd, 'contract.json'), JSON.stringify({ version: 1, assertions: [{ type: 'json_equals', path: 'result.json', field: ['answer'], value: 42 }, { type: 'write_readback', path: 'result.json' }] }));
  let n = 0, continued = false;
  const env = await server(t, req => {
    n++;
    if (n === 1) return response({ tool_calls: [call('r', 'read_file', { path: 'input.txt' }), call('w', 'write_file', { path: 'result.json', content: '{"answer":0}' })] });
    if (n === 2) return response({ content: 'private-probe-key 已完成' });
    continued = req.messages.some(m => m.tool_call_id === 'r' && m.content.includes('private-probe-key')) && req.messages.some(m => m.tool_call_id === 'w') && req.messages.some(m => m.content?.includes('验收 failed'));
    return response({ content: '继续会话' });
  });
  const first = await cliRun(cwd, ['run', '--session', 'cross-process', '--contract', 'contract.json', '--prompt', 'write', '--json'], env);
  assert.equal(first.code, 1);
  const output = JSON.parse(first.stdout);
  assert.equal(output.modelStatus, 'completed'); assert.equal(output.status, 'failed'); assert.equal(output.verification.status, 'failed');
  assert(!first.stdout.includes('private-probe-key')); assert(!first.stderr.includes('private-probe-key'));
  const second = await cliRun(cwd, ['run', '--session', 'cross-process', '--prompt', 'continue', '--json'], env);
  assert.equal(second.code, 0, second.stdout); assert(continued);
  const ledger = await loadSession(cwd, 'cross-process');
  assert.equal(ledger.runs.length, 2); assert.equal(ledger.runs[0].tools.length, 2);
  assert.equal(ledger.runs[0].tools[0].result.result.content, 'private-probe-key');
  assert.equal(ledger.runs[0].capabilitySnapshot.tools.length, 4);
  const listing = await cliRun(cwd, ['sessions', '--json'], env);
  assert.equal(JSON.parse(listing.stdout)[0].id, 'cross-process'); assert(!listing.stdout.includes('private-probe-key'));
});

test('crash: durable intent is unknown, stale lock recovered, no write replay and protocol repaired only in derived history', async t => {
  const { loadSession, sessionHistory } = await import(sessionsUrl);
  const { spawn } = await import('node:child_process');
  const cwd = await workspace(t);
  const source = `import { openSession } from ${JSON.stringify(sessionsUrl.href)};
    const s = await openSession(process.argv[1], 'crashed');
    s.data.runs.push({ id:'r', status:'running', messages:[{role:'user',content:'task'},{role:'assistant',content:null,tool_calls:[{id:'a',type:'function',function:{name:'write_file',arguments:'{}'}},{id:'b',type:'function',function:{name:'write_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'a',content:'{"ok":true}'}],events:[],tools:[{callId:'b',name:'write_file',arguments:{path:'must-not-replay',content:'bad'},status:'intent'}] });
    await s.save(); process.stdout.write('READY'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, cwd]);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`premature exit ${code}`))); });
  child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
  const ledger = await loadSession(cwd, 'crashed');
  assert.equal(ledger.runs[0].status, 'interrupted'); assert.equal(ledger.runs[0].tools[0].status, 'unknown');
  assert.equal(ledger.runs[0].messages.length, 3);
  const history = sessionHistory(ledger);
  assert.equal(history.filter(m => m.role === 'tool').length, 2); assert(history.find(m => m.tool_call_id === 'b').content.includes('unknown'));
  await assert.rejects(fs.stat(path.join(cwd, 'must-not-replay')), { code: 'ENOENT' });
  let protocol = false;
  const env = await server(t, req => { protocol = req.messages.some(m => m.tool_call_id === 'b' && m.content.includes('unknown')); return response({ content: '检查后继续' }); });
  const result = await cliRun(cwd, ['run', '--session', 'crashed', '--prompt', 'continue without writing', '--json'], env);
  assert.equal(result.code, 0, result.stdout); assert(protocol);
  await assert.rejects(fs.stat(path.join(cwd, 'must-not-replay')), { code: 'ENOENT' });
});

test('security: protected skill loading and symlink state cannot expose .eve', async t => {
  const { openSession } = await import(sessionsUrl);
  const { createTools } = await import('../src/tools.mjs');
  const { discoverSkills } = await import('../src/skills.mjs');
  const { DEFAULTS } = await import('../src/config.mjs');
  const cwd = await workspace(t);
  await fs.mkdir(path.join(cwd, '.eve', 'hidden'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.eve/hidden/SKILL.md'), '---\nname: hidden\ndescription: private\n---\nprivate body');
  const config = { ...DEFAULTS, skillsDirs: ['.eve/hidden'], userSkills: false };
  const exec = await createTools(cwd, await discoverSkills(cwd, config), config);
  await assert.rejects(exec('load_skill', '{"name":"hidden"}'), /保护|配置/);
  const outside = await workspace(t);
  await fs.symlink(outside, path.join(cwd, '.eve', 'sessions'));
  await assert.rejects(openSession(cwd, 'safe'), /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('durability: live writer excludes another process, corrupt data is preserved, fresh files survive interrupted temp writes', async t => {
  const { openSession, loadSession } = await import(sessionsUrl);
  const cwd = await workspace(t);
  const s = await openSession(cwd, 'locked');
  const busy = await cliRun(cwd, ['run', '--session', 'locked', '--prompt', 'no', '--json']);
  assert.equal(busy.code, 1); assert(busy.stdout.includes('锁'));
  await s.close();
  const file = path.join(cwd, '.eve/sessions/locked.json');
  const bytes = await fs.readFile(file);
  await fs.writeFile(file + '.orphan.tmp', '{partial');
  assert.equal((await loadSession(cwd, 'locked')).id, 'locked');
  assert.deepEqual(await fs.readFile(file), bytes);
  await fs.writeFile(file, '{corrupted-private-probe-key');
  await assert.rejects(openSession(cwd, 'locked'));
  assert.equal(await fs.readFile(file, 'utf8'), '{corrupted-private-probe-key');
});

test('acceptance: valid writes pass readback; failed tool batches remain protocol-complete in continuation', async t => {
  const { runSession, loadSession } = await import(sessionsUrl);
  const { DEFAULTS } = await import('../src/config.mjs');
  const cwd = await workspace(t);
  const config = { ...DEFAULTS, userSkills: false, maxToolCalls: 1 };
  const fetchImpl = async () => new Response(JSON.stringify(response({ tool_calls: [call('a', 'write_file', { path: 'good.txt', content: 'right' }), call('b', 'write_file', { path: 'not-written', content: 'bad' })] })));
  const failed = await runSession({ cwd, config, sessionId: 'budget', prompt: 'write', fetchImpl });
  assert.equal(failed.status, 'budget_exceeded');
  assert.equal(failed.messages.filter(m => m.role === 'tool').length, 2);
  let n = 0;
  const good = await runSession({ cwd, config, sessionId: 'budget', prompt: 'verify', contract: { version: 1, assertions: [{ type: 'file_exists', path: 'good.txt' }, { type: 'text_contains', path: 'good.txt', text: 'right' }, { type: 'write_readback', path: 'good.txt' }] }, fetchImpl: async () => new Response(JSON.stringify(response(++n === 1 ? { tool_calls: [call('c', 'write_file', { path: 'good.txt', content: 'right' })] } : { content: 'done' }))) });
  assert.equal(good.status, 'completed'); assert.equal(good.verification.status, 'passed');
  const ledger = await loadSession(cwd, 'budget');
  assert.equal(ledger.runs[0].status, 'budget_exceeded');
  assert.equal(ledger.runs[0].tools.length, 2);
  assert.equal(ledger.runs[0].tools[1].status, 'not_executed');
  assert.equal(ledger.runs[1].messages.filter(m => m.role === 'tool').length, 3);
  await assert.rejects(fs.stat(path.join(cwd, 'not-written')), { code: 'ENOENT' });
});

test('agent crash window: completed write retained, next durable intent becomes unknown without dispatch', async t => {
  const { loadSession } = await import(sessionsUrl);
  const { spawn } = await import('node:child_process');
  const cwd = await workspace(t);
  const source = `import { runSession } from ${JSON.stringify(sessionsUrl.href)};
    import { DEFAULTS } from ${JSON.stringify(pathToFileURL(path.resolve('src/config.mjs')).href)};
    const calls = ${JSON.stringify([call('a', 'write_file', { path: 'first.txt', content: 'once' }), call('b', 'write_file', { path: 'never.txt', content: 'never' })])};
    await runSession({cwd:process.argv[1],sessionId:'window',config:{...DEFAULTS,userSkills:false},prompt:'write',fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:calls},finish_reason:'tool_calls'}]})),onEvent:e=>{if(e.type==='tool_start'&&e.callId==='b') process.kill(process.pid,'SIGKILL');}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, cwd]);
  child.stderr.resume();
  const signal = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (_code, sig) => resolve(sig)); });
  assert.equal(signal, 'SIGKILL');
  assert.equal(await fs.readFile(path.join(cwd, 'first.txt'), 'utf8'), 'once');
  const ledger = await loadSession(cwd, 'window');
  assert.deepEqual(ledger.runs[0].tools.map(x => x.status), ['completed', 'unknown']);
  assert.equal(ledger.runs[0].messages.filter(m => m.role === 'tool').length, 1);
  await assert.rejects(fs.stat(path.join(cwd, 'never.txt')), { code: 'ENOENT' });
});

test('failed response: truncated tool intent is retained as raw evidence without entering executable history', async t => {
  const { runSession, loadSession } = await import(sessionsUrl);
  const { DEFAULTS } = await import('../src/config.mjs');
  const cwd = await workspace(t);
  const data = response({ tool_calls: [call('truncated', 'write_file', { path: 'never', content: 'partial' })] });
  data.choices[0].finish_reason = 'length';
  const result = await runSession({ cwd, config: { ...DEFAULTS, userSkills: false }, sessionId: 'truncated', prompt: 'write', fetchImpl: async () => new Response(JSON.stringify(data)) });
  assert.equal(result.error.code, 'OUTPUT_LIMIT');
  const run = (await loadSession(cwd, 'truncated')).runs[0];
  assert.equal(run.responses[0].message.tool_calls[0].id, 'truncated');
  assert.equal(run.messages.filter(m => m.role === 'assistant').length, 0);
  await assert.rejects(fs.stat(path.join(cwd, 'never')), { code: 'ENOENT' });
});
