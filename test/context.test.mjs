import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSession, loadSession } from '../src/sessions.mjs';
import { runAgent } from '../src/agent.mjs';
import { validateConfig } from '../src/config.mjs';
const cfg = x => validateConfig({ userSkills: false, contextMaxChars: 12000, contextRecentGroups: 1, ...x });
const response = content => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
async function workspace(t) { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-context-')); t.after(() => fs.rm(cwd, { recursive: true, force: true })); return cwd; }
const oldHistory = () => [{ role: 'user', content: 'Correction: random fact blue-7812; do not use red.' }, ...Array.from({ length: 12 }, (_, i) => [{ role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"data"}' } }] }, { role: 'tool', tool_call_id: `t${i}`, content: JSON.stringify({ ok: true, result: { content: 'data'.repeat(700) } }) }]).flat()];
function protocol(messages) { for (let i = 0; i < messages.length; i++) { const m = messages[i]; if (m.role === 'tool') assert.fail('orphan'); if (m.tool_calls) for (const call of m.tool_calls) { const result = messages[++i]; assert.equal(result?.role, 'tool'); assert.equal(result.tool_call_id, call.id); JSON.parse(result.content); } } }
test('context: forced small budget summarizes once, preserves correction/source and complete recent groups', async t => {
 const cwd = await workspace(t); let summaries = 0, requests = 0;
 const r = await runAgent({ cwd, config: cfg(), history: oldHistory(), prompt: 'continue', fetchImpl: async (_u, o) => {
  const q = JSON.parse(o.body); requests++;
  if (!q.tools) { summaries++; return response('Earlier data was read.'); }
  assert(JSON.stringify(q.messages).length + JSON.stringify(q.tools).length <= 12000);
  protocol(q.messages); assert(JSON.stringify(q.messages).includes('blue-7812')); assert(q.messages.some(m => m.tool_call_id === 't11'));
  return response('done');
 } });
 assert.equal(r.status, 'completed'); assert.equal(summaries, 1); assert.equal(r.stats.modelRequests, requests); assert.equal(r.stats.summaryRequests, 1);
 assert(r.messages.length > r.context.view.length); assert(r.context.summary.sources.every(s => s.sha256 && Number.isInteger(s.index)));
 assert.equal(r.events.filter(e => e.type === 'context_summary').length, 1);
});
test('context: summary failure falls back transparently, required group overflow fails before model request', async t => {
 const cwd = await workspace(t);
 const r = await runAgent({ cwd, config: cfg(), history: oldHistory(), prompt: 'continue', fetchImpl: async (_u, o) => { if (!JSON.parse(o.body).tools) throw new Error('unavailable'); return response('done'); } });
 assert.equal(r.status, 'completed'); assert.equal(r.context.summary.method, 'deterministic'); assert(r.events.some(e => e.type === 'context_summary' && e.fallback));
 let calls = 0;
 const huge = await runAgent({ cwd, config: cfg(), history: [{ role: 'assistant', content: null, tool_calls: [{ id: 'big', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'big', content: JSON.stringify({ content: 'x'.repeat(16000) }) }], prompt: 'next', fetchImpl: async () => { calls++; return response('no'); } });
 assert.equal(huge.error.code, 'CONTEXT'); assert.equal(calls, 0);
});
test('context: persistent derived view, immutable original logs, no extra summary for a small task', async t => {
 const cwd = await workspace(t); let calls = 0;
 const fetchImpl = async () => { calls++; return response('ok'); };
 const first = await runSession({ cwd, config: cfg(), sessionId: 'persist', prompt: 'remember nonce-9831', fetchImpl });
 assert.equal(first.status, 'completed'); assert.equal(calls, 1); assert.equal(first.stats.summaryRequests, 0);
 const before = await loadSession(cwd, 'persist');
 const second = await runSession({ cwd, config: cfg(), sessionId: 'persist', prompt: 'continue', compact: true, fetchImpl });
 assert.equal(second.status, 'completed');
 const after = await loadSession(cwd, 'persist'); assert.deepEqual(after.runs[0], before.runs[0]); assert(after.runs[1].context);
});
test('context: expired loaded skill never enters summary, user anchors cannot silently disappear', async t => {
 const cwd = await workspace(t); const history = oldHistory();
 history.unshift({ role: 'assistant', content: null, tool_calls: [{ id: 'skill', type: 'function', function: { name: 'load_skill', arguments: '{"name":"probe"}' } }] }, { role: 'tool', tool_call_id: 'skill', content: '{"content":"REVOKED_SECRET_BODY"}' });
 const r = await runAgent({ cwd, config: cfg(), history, prompt: 'continue', fetchImpl: async (_u, o) => { assert(!o.body.includes('REVOKED_SECRET_BODY')); return response('ok'); } });
 assert.equal(r.status, 'completed'); assert(!JSON.stringify(r.context).includes('REVOKED_SECRET_BODY'));
 const anchors = await runAgent({ cwd, config: cfg(), history: [{ role: 'user', content: 'correction'.repeat(4000) }, ...oldHistory()], prompt: 'next', fetchImpl: async () => response('no') });
 assert.equal(anchors.error.code, 'CONTEXT');
});
test('context config rejects invalid budgets', () => { for (const c of [{ contextMaxChars: 0 }, { contextMaxChars: 1000001 }, { contextRecentGroups: 0 }, { contextSummaryChars: 0 }]) assert.throws(() => cfg(c)); });

test('context: interrupted run retains messages appended after a summary checkpoint', async () => {
 const { sessionHistory } = await import('../src/sessions.mjs');
 const base = [{ role: 'user', content: 'task' }];
 const tail = [{ role: 'assistant', content: null, tool_calls: [{ id: 'late', type: 'function', function: { name: 'write_file', arguments: '{}' } }] }];
 const data = { runs: [{ id: 'r', status: 'interrupted', messages: [...base, ...tail], context: { view: base, rawCount: 1 }, events: [] }] };
 const history = sessionHistory(data); assert(history.some(m => m.tool_call_id === 'late' && m.content.includes('unknown')));
});

test('context: many messages below char budget bypass former 100-message limit, step ceiling includes summary', async t => {
 const cwd = await workspace(t);
 const many = await runAgent({ cwd, config: cfg(), prompt: 'task', history: Array.from({ length: 110 }, () => ({ role: 'assistant', content: 'ok' })), fetchImpl: async () => response('done') });
 assert.equal(many.status, 'completed'); assert.equal(many.stats.modelRequests, 1);
 const limited = await runAgent({ cwd, config: cfg({ maxSteps: 1 }), prompt: 'task', history: oldHistory(), fetchImpl: async (_u, o) => { assert(JSON.parse(o.body).tools); return response('done'); } });
 assert.equal(limited.status, 'completed'); assert.equal(limited.stats.modelRequests, 1); assert.equal(limited.stats.summaryRequests, 0);
});

test('context: final answer cannot displace latest tool group; changed skills invalidate previous model summary', async t => {
 const cwd = await workspace(t);
 const history = oldHistory(); history.push({ role: 'assistant', content: 'finished' });
 const r = await runAgent({ cwd, config: cfg(), prompt: 'continue', history, previousSkills: [{ name: 'revoked', hash: 'old' }], contextSummary: { sources: [], users: [], trajectory: [], method: 'model', modelSummary: 'OLD_SKILL_BODY', sourceDigest: 'old' }, fetchImpl: async (_u, o) => { const q = JSON.parse(o.body); assert(!o.body.includes('OLD_SKILL_BODY')); if (q.tools) { protocol(q.messages); assert(q.messages.some(m => m.tool_call_id === 't11')); } return response('ok'); } });
 assert.equal(r.status, 'completed'); assert(r.events.some(e => e.type === 'context_skill_expired'));
});

test('context integration: independent CLI processes compact and resume persisted raw tool history', async t => {
 const { createServer } = await import('node:http');
 const { spawn } = await import('node:child_process');
 const cwd = await workspace(t); await fs.writeFile(path.join(cwd, 'data'), 'x'.repeat(7000)); await fs.writeFile(path.join(cwd, 'small'), 'small recent result');
 let regular = 0;
 const srv = createServer(async (req, res) => {
  let text = ''; for await (const c of req) text += c;
  const q = JSON.parse(text); let message;
  if (!q.tools) message = { role: 'assistant', content: 'File data was inspected.' };
  else {
   protocol(q.messages); regular++;
   if (regular === 1 || regular === 3) message = { role: 'assistant', content: null, tool_calls: [{ id: `read${regular}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: regular === 1 ? 'data' : 'small' }) } }] };
   else message = { role: 'assistant', content: 'done' };
  }
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
 });
 await new Promise(r => srv.listen(0, '127.0.0.1', r)); t.after(() => { srv.closeAllConnections(); srv.close(); });
 await fs.mkdir(path.join(cwd, '.eve'));
 const settings = cfg({ baseUrl: `http://127.0.0.1:${srv.address().port}`, contextMaxChars: 20000 });
 const save = () => fs.writeFile(path.join(cwd, '.eve/config.local.json'), JSON.stringify(settings)); await save();
 const cli = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../bin/eve.mjs'), ...args, '--cwd', cwd, '--session', 'cli', '--json'], { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('EVE_'))) });
  let out = ''; child.stdout.on('data', c => out += c); child.stderr.resume(); child.on('error', reject); child.on('close', code => { try { assert.equal(code, 0, out); resolve(JSON.parse(out)); } catch (e) { reject(e); } });
 });
 await cli(['run', '--prompt', 'remember original correction QZ-812 then read data']);
 await cli(['run', '--prompt', 'read small']);
 const before = await loadSession(cwd, 'cli'); settings.contextMaxChars = 9000; await save();
 const compact = await cli(['compact']); assert.equal(compact.stats.summaryRequests, 1);
 const compressed = await loadSession(cwd, 'cli'); assert.deepEqual(compressed.runs, before.runs); assert(compressed.context.summary.users.some(u => u.content.includes('QZ-812'))); assert(compressed.contextEvents.length > 0);
 const next = await cli(['run', '--prompt', 'continue']); assert.equal(next.status, 'completed'); assert.equal(next.stats.summaryRequests, 0);
 assert(!JSON.stringify(next).includes('QZ-812'), 'CLI must not expose summary originals');
 const after = await loadSession(cwd, 'cli'); assert(after.runs.at(-1).context.summary.users.some(u => u.content.includes('QZ-812')));
});
