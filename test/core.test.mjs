import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULTS, validateConfig, loadConfig, redactConfig, redact, setLocalConfig } from '../src/config.mjs';
import { discoverSkills, loadSkill, skillsCatalog } from '../src/skills.mjs';
import { createTools } from '../src/tools.mjs';
import { runAgent, withAbort } from '../src/agent.mjs';

const root = path.resolve(import.meta.dirname, '..');
async function workspace(t) {
  await fs.mkdir(path.join(root, '.eve'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, '.eve', 'verify-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const cfg = overrides => validateConfig({ ...DEFAULTS, userSkills: false, ...overrides });
const response = (message, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }], usage: { prompt_tokens: 7, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
async function skill(dir, text = 'ONLY_IN_BODY_63a2') {
  const folder = path.join(dir, 'skills', 'probe'); await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, 'SKILL.md');
  await fs.writeFile(file, `---\nname: probe\ndescription: A verification skill\n---\n${text}\n`);
  return file;
}

test('config: defaults < files < environment < explicit overrides; redaction and validation', async t => {
  const cwd = await workspace(t);
  await fs.mkdir(path.join(cwd, '.eve'));
  await fs.writeFile(path.join(cwd, '.eve', 'config.json'), JSON.stringify({ model: 'file-model', maxSteps: 4 }));
  await fs.writeFile(path.join(cwd, '.eve', 'config.local.json'), JSON.stringify({ model: 'local-model', apiKey: 'test-secret-not-real' }));
  const c = await loadConfig({ cwd, env: { EVE_MODEL: 'env-model' }, overrides: { maxSteps: 5 } });
  assert.equal(c.model, 'env-model'); assert.equal(c.maxSteps, 5);
  assert.equal(redactConfig(c).apiKey, '[configured]');
  assert(!redact('x test-secret-not-real \x1b[31mred', c).includes(c.apiKey));
  assert.throws(() => cfg({ timeoutMs: 0 }));
  assert.throws(() => cfg({ unknown: true }));
  assert.throws(() => cfg({ baseUrl: 'http://user:pass@localhost' }));
  await assert.rejects(setLocalConfig(cwd, 'apiKey', 'x'));
  await setLocalConfig(cwd, 'maxSteps', '8');
  assert.equal((await loadConfig({ cwd, env: {} })).maxSteps, 8);
});

test('skills: metadata-only discovery, malformed files skipped, symlinks skipped, content hashes enforced', async t => {
  const cwd = await workspace(t); const file = await skill(cwd);
  await fs.mkdir(path.join(cwd, 'skills', 'bad')); await fs.writeFile(path.join(cwd, 'skills', 'bad', 'SKILL.md'), 'no header');
  await fs.symlink(path.dirname(file), path.join(cwd, 'skills', 'linked'));
  const d = await discoverSkills(cwd, cfg());
  assert.deepEqual([...d.skills.keys()], ['probe']); assert.equal(d.warnings.length, 1);
  assert(!skillsCatalog(d.skills).includes('ONLY_IN_BODY'));
  assert((await loadSkill(d.skills.get('probe'))).content.includes('ONLY_IN_BODY'));
  await fs.appendFile(file, 'changed');
  await assert.rejects(loadSkill(d.skills.get('probe')), /发生变化/);
});

test('tools: actual write/read, argument checks, traversal/protected files/symlink rejection', async t => {
  const cwd = await workspace(t);
  const d = await discoverSkills(cwd, cfg()); const exec = await createTools(cwd, d, cfg());
  assert.equal((await exec('write_file', JSON.stringify({ path: 'out/a.txt', content: 'hello' }))).written, true);
  assert.equal((await exec('read_file', '{"path":"out/a.txt"}')).content, 'hello');
  for (const p of ['../outside', '/etc/passwd', '.eve/config.local.json', '.env', 'out/../../x']) await assert.rejects(exec('read_file', JSON.stringify({ path: p })));
  await fs.symlink(path.join(cwd, 'out'), path.join(cwd, 'link'));
  await assert.rejects(exec('write_file', '{"path":"link/hack","content":"x"}'), /符号链接/);
  await assert.rejects(exec('write_file', '{"path":"ok","content":"x","extra":true}'));
  await assert.rejects(exec('read_file', 'not-json'));
  await assert.rejects(exec('shell', '{}'));
});

test('agent: metadata → load_skill → injected tool result → read/write → final with valid tool protocol', async t => {
  const cwd = await workspace(t); await skill(cwd); await fs.writeFile(path.join(cwd, 'input.txt'), 'nonce-actual-file');
  let n = 0;
  const fetchImpl = async (_url, opts) => {
    const req = JSON.parse(opts.body); n++;
    assert(req.messages[0].content.includes('probe'));
    if (n === 1) { assert(!req.messages[0].content.includes('ONLY_IN_BODY')); return response({ tool_calls: [call('c1', 'load_skill', { name: 'probe' })] }, 'tool_calls'); }
    if (n === 2) {
      const result = req.messages.at(-1); assert.equal(result.role, 'tool'); assert.equal(result.tool_call_id, 'c1');
      assert(result.content.includes('ONLY_IN_BODY'));
      return response({ tool_calls: [call('c2', 'read_file', { path: 'input.txt' })] }, 'tool_calls');
    }
    if (n === 3) { assert(req.messages.at(-1).content.includes('nonce-actual-file')); return response({ tool_calls: [call('c3', 'write_file', { path: 'result.txt', content: 'verified nonce-actual-file' })] }, 'tool_calls'); }
    assert.equal(JSON.parse(req.messages.at(-1).content).ok, true);
    return response({ content: '完成' });
  };
  const r = await runAgent({ cwd, config: cfg(), prompt: 'Use probe', fetchImpl });
  assert.equal(r.status, 'completed'); assert.equal(r.stats.modelRequests, 4);
  assert.equal(await fs.readFile(path.join(cwd, 'result.txt'), 'utf8'), 'verified nonce-actual-file');
  assert(r.events.some(e => e.type === 'tool_end' && e.name === 'load_skill' && e.injectedChars > 0));
});

test('agent: malformed arguments become tool errors; model can correct and continue', async t => {
  const cwd = await workspace(t); let n = 0;
  const r = await runAgent({ cwd, config: cfg(), prompt: 'test', fetchImpl: async (_u, opts) => {
    n++; if (n === 1) return response({ tool_calls: [call('bad', 'read_file', '{broken')] }, 'tool_calls');
    const req = JSON.parse(opts.body); assert.equal(JSON.parse(req.messages.at(-1).content).ok, false);
    return response({ content: '明确报告工具错误' });
  } });
  assert.equal(r.status, 'completed'); assert(r.events.some(e => e.type === 'tool_end' && e.ok === false));
});

test('agent: step/tool budgets stop real execution; no orphan tool calls in returned history', async t => {
  const cwd = await workspace(t);
  const endless = async () => response({ tool_calls: [call('loop', 'list_files', {})] }, 'tool_calls');
  const steps = await runAgent({ cwd, config: cfg({ maxSteps: 2 }), prompt: 'test', fetchImpl: endless });
  assert.equal(steps.error.code, 'STEP_BUDGET'); assert.equal(steps.stats.modelRequests, 2);
  const tools = await runAgent({ cwd, config: cfg({ maxToolCalls: 1 }), prompt: 'test', fetchImpl: async () => response({ tool_calls: [call('a', 'list_files', {}), call('b', 'write_file', { path: 'not-created', content: 'no' })] }, 'tool_calls') });
  assert.equal(tools.error.code, 'TOOL_BUDGET'); assert.equal(tools.stats.toolCalls, 1);
  assert.equal(tools.messages.filter(m => m.role === 'tool').length, 2);
  await assert.rejects(fs.stat(path.join(cwd, 'not-created')), { code: 'ENOENT' });
});

test('agent: timeout/cancel actually abort pending request; HTTP/protocol failures are explicit', async t => {
  const cwd = await workspace(t);
  const waiting = async (_u, opts) => new Promise((_resolve, reject) => { opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }); });
  // Keep the test process alive: AbortSignal.timeout uses an unref timer.
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  const timeout = await runAgent({ cwd, config: cfg({ timeoutMs: 20 }), prompt: 'test', fetchImpl: waiting });
  assert.equal(timeout.status, 'timeout');
  const ac = new AbortController(); setTimeout(() => ac.abort(), 10);
  const cancelled = await runAgent({ cwd, config: cfg(), prompt: 'test', signal: ac.signal, fetchImpl: waiting });
  assert.equal(cancelled.status, 'cancelled');
  const http = await runAgent({ cwd, config: cfg(), prompt: 'test', fetchImpl: async () => new Response('private provider payload', { status: 401 }) });
  assert.equal(http.error.code, 'HTTP'); assert(!JSON.stringify(http).includes('private provider payload'));
  const truncated = await runAgent({ cwd, config: cfg(), prompt: 'test', fetchImpl: async () => response({ content: 'unfinished' }, 'length') });
  assert.equal(truncated.error.code, 'OUTPUT_LIMIT');
});

test('regression: truncated model tool calls cannot write files', async t => {
  const cwd = await workspace(t);
  const r = await runAgent({ cwd, config: cfg(), prompt: 'test', fetchImpl: async () => response({ tool_calls: [call('cut', 'write_file', { path: 'must-not-exist', content: 'bad' })] }, 'length') });
  assert.equal(r.error.code, 'OUTPUT_LIMIT');
  assert.equal(r.stats.toolCalls, 0);
  await assert.rejects(fs.stat(path.join(cwd, 'must-not-exist')), { code: 'ENOENT' });
});

test('regression: rejected oversized writes leave no parent directories', async t => {
  const cwd = await workspace(t);
  const exec = await createTools(cwd, await discoverSkills(cwd, cfg()), cfg());
  await assert.rejects(exec('write_file', JSON.stringify({ path: 'must-not-exist/child/file', content: 'x'.repeat(65537) })), /64 KiB/);
  await assert.rejects(fs.stat(path.join(cwd, 'must-not-exist')), { code: 'ENOENT' });
});

test('regression: cancellation stops waiting for a non-cooperative tool promise', async () => {
  const ac = new AbortController();
  const stuck = new Promise(() => {});
  const timer = setTimeout(() => ac.abort(new Error('tool deadline')), 10);
  try { await assert.rejects(withAbort(stuck, ac.signal), /tool deadline/); }
  finally { clearTimeout(timer); }
});
