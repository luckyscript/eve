import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as exec } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULTS } from '../src/config.mjs';
import { discoverSkills, loadSkill } from '../src/skills.mjs';
import { createTools } from '../src/tools.mjs';

const execFile = promisify(exec);
export const skillText = body => `---\nname: inventory\ndescription: Build inventory reports\n---\n${body}\n`;
async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-evolution-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, 'skills/inventory'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'skills/inventory/SKILL.md'), skillText('old instructions'));
  return { cwd, config: { ...DEFAULTS, userSkills: false } };
}
async function registry() { return import('../src/registry.mjs'); }

test('ordinary tools cannot modify skill roots or inject SKILL.md', async t => {
  const { cwd, config } = await fixture(t);
  const tools = await createTools(cwd, await discoverSkills(cwd, config), config);
  for (const file of ['skills/inventory/SKILL.md', 'skills/new/SKILL.md', 'other/SKILL.md', '.eve/evolution/state.json']) {
    await assert.rejects(tools('write_file', JSON.stringify({ path: file, content: 'attack' })), /技能|保护/);
  }
});

test('immutable registry candidates stay isolated; explicit baseline snapshots survive pointer changes', async t => {
  const { cwd, config } = await fixture(t);
  const r = await registry();
  const baseline = await r.importBaseline(cwd, 'skills/inventory/SKILL.md');
  const candidate = await r.createCandidate(cwd, skillText('new instructions'), { parent: baseline.hash });
  const d = await discoverSkills(cwd, config);
  assert.equal(d.skills.get('inventory').hash, baseline.hash);
  assert.equal((await loadSkill(d.skills.get('inventory'))).content, skillText('old instructions'));
  assert.notEqual(candidate.hash, baseline.hash);
  await assert.rejects(r.promote(cwd, candidate.id), /评测/);
  assert.equal((await r.capabilities(cwd)).active.inventory, baseline.hash);
  assert.equal((await fs.stat(path.join(cwd, '.eve/evolution/state.json'))).mode & 0o777, 0o600);
  const module = new URL('../src/registry.mjs', import.meta.url).href;
  const out = await execFile(process.execPath, ['--input-type=module', '-e', `import {capabilities} from ${JSON.stringify(module)}; console.log(JSON.stringify((await capabilities(process.argv[1])).active));`, cwd]);
  assert.equal(JSON.parse(out.stdout).inventory, baseline.hash);
  await fs.writeFile(path.join(cwd, '.eve/evolution/objects', baseline.hash + '.json'), '{}');
  await assert.rejects(discoverSkills(cwd, config), /hash|对象/);
});

test('registry lock fails closed and rejects symlink state roots', async t => {
  const { cwd } = await fixture(t); const r = await registry();
  await fs.mkdir(path.join(cwd, '.eve'));
  await fs.symlink(os.tmpdir(), path.join(cwd, '.eve/evolution'));
  await assert.rejects(r.capabilities(cwd), /符号|目录/);
});

const contract = value => ({ version: 1, assertions: [{ type: 'json_equals', path: 'out.json', field: ['items'], value }, { type: 'write_readback', path: 'out.json' }] });
const response = message => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }], usage: {} }));
function modelMock(capture, improved = true) {
  return async (_url, init) => {
    const req = JSON.parse(init.body); capture.push(req);
    if (!req.tools) return response({ content: skillText(improved ? 'trim filter instructions' : 'still bad instructions') });
    const tool = req.messages.filter(m => m.role === 'tool');
    let call;
    if (!tool.length) call = ['load_skill', { name: 'inventory' }];
    else if (tool.length === 1) call = ['read_file', { path: 'in.txt' }];
    else if (tool.length === 2) {
      const skill = JSON.parse(tool[0].content).result.content;
      const input = JSON.parse(tool[1].content).result.content;
      const items = skill.includes('trim filter') ? input.split('\n').map(x => x.trim()).filter(Boolean) : input.split('\n');
      call = ['write_file', { path: 'out.json', content: JSON.stringify({ items }) }];
    } else return response({ content: 'done' });
    return response({ content: null, tool_calls: [{ id: 'c' + tool.length, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] });
  };
}
async function evolutionFixture(t, improved = true) {
  const f = await fixture(t), r = await registry();
  const { runSession } = await import('../src/sessions.mjs');
  const captures = [], fetchImpl = modelMock(captures, improved);
  f.config = { ...f.config, maxSteps: 4, maxOutputTokens: 512, timeoutMs: 10000 };
  const baseline = await r.importBaseline(f.cwd, 'skills/inventory/SKILL.md');
  await fs.writeFile(path.join(f.cwd, 'in.txt'), ' x \n');
  const source = await runSession({ ...f, prompt: 'Build inventory from in.txt into out.json', contract: contract(['x']), fetchImpl });
  assert.equal(source.verification.status, 'failed');
  const suite = { version: 1, budget: { maxSteps: 4, maxToolCalls: 8, maxOutputTokens: 512, timeoutMs: 10000 }, maxCandidates: 2, cases: [
    { id: 'whitespace', files: { 'in.txt': ' HIDDEN_CANARY \n\n' }, prompt: 'Build inventory from in.txt into out.json', contract: contract(['HIDDEN_CANARY']) },
    { id: 'clean', files: { 'in.txt': 'abc' }, prompt: 'Build inventory from in.txt into out.json', contract: contract(['abc']) },
  ] };
  await fs.writeFile(path.join(f.cwd, 'suite.json'), JSON.stringify(suite));
  return { ...f, source, baseline, captures, fetchImpl, suiteFile: 'suite.json' };
}

test('real execution pipeline excludes hidden material and publishes only comparative success; rollback pins old snapshots', async t => {
  const f = await evolutionFixture(t);
  const { evolve } = await import('../src/evolution.mjs');
  const r = await registry();
  const before = await discoverSkills(f.cwd, f.config);
  const result = await evolve({ ...f, sessionId: f.source.sessionId, runId: f.source.runId, skill: 'inventory', correction: 'Trim each line, discard blanks; preserve duplicates and order.', maxRequests: 20 });
  assert.equal(result.status, 'promoted');
  assert.equal(result.evaluation.cases.length, 2);
  assert.ok(result.evaluation.cases.every(x => x.candidate.passed));
  const generator = f.captures.find(req => !req.tools);
  assert.ok(generator);
  assert.ok(!JSON.stringify(generator).includes('HIDDEN_CANARY'));
  assert.ok(!JSON.stringify(generator).includes('assertions'));
  assert.equal(generator.tool_choice, undefined);
  assert.equal((await r.capabilities(f.cwd)).active.inventory, result.candidate.hash);
  const snapshot = await discoverSkills(f.cwd, f.config);
  await r.rollback(f.cwd, 'inventory');
  assert.equal((await discoverSkills(f.cwd, f.config)).skills.get('inventory').hash, f.baseline.hash);
  assert.equal((await loadSkill(snapshot.skills.get('inventory'))).hash, result.candidate.hash);
  assert.equal((await loadSkill(before.skills.get('inventory'))).hash, f.baseline.hash);
  await assert.rejects(r.promote(f.cwd, result.candidate.id), /评测/);
});

test('failed or missing evaluation cannot promote and candidate attempts are lineage bounded', async t => {
  const f = await evolutionFixture(t, false);
  const { evolve } = await import('../src/evolution.mjs'); const r = await registry();
  const args = { ...f, sessionId: f.source.sessionId, runId: f.source.runId, skill: 'inventory', maxRequests: 20 };
  const result = await evolve(args);
  assert.equal(result.status, 'rejected');
  assert.equal((await r.capabilities(f.cwd)).active.inventory, f.baseline.hash);
  await assert.rejects(r.promote(f.cwd, result.candidate.id), /评测/);
  await evolve(args);
  await assert.rejects(evolve(args), /谱系|次数/);
});

test('suite validation rejects traversal, skill injection, malformed assertions and insufficient request caps before spending', async t => {
  const f = await evolutionFixture(t); const { evolve, validateSuite } = await import('../src/evolution.mjs');
  for (const file of ['../x', '.eve/x', 'skills/x/SKILL.md']) {
    assert.throws(() => validateSuite({ version: 1, cases: [{ id: 'x', prompt: 'test', files: { [file]: 'x' }, contract: contract([]) }] }), /路径|技能|保护/);
  }
  const n = f.captures.length;
  await assert.rejects(evolve({ ...f, sessionId: f.source.sessionId, runId: f.source.runId, skill: 'inventory', maxRequests: 1 }), /预算/);
  assert.equal(f.captures.length, n);
});

test('exact text and hash contracts are independently checked', async t => {
  const { cwd } = await fixture(t); const { verifyContract } = await import('../src/contracts.mjs'); const { sha256 } = await registry();
  await fs.writeFile(path.join(cwd, 'out.txt'), 'Unicode 文\n');
  const c = { version: 1, assertions: [{ type: 'text_equals', path: 'out.txt', text: 'Unicode 文\n' }, { type: 'sha256_equals', path: 'out.txt', sha256: sha256('Unicode 文\n') }] };
  assert.equal((await verifyContract(cwd, c)).status, 'passed');
  await fs.writeFile(path.join(cwd, 'out.txt'), 'Unicode 文');
  assert.equal((await verifyContract(cwd, c)).status, 'failed');
});

test('publication CAS rejects competing evaluated candidates and a fresh process loads the new hash', async t => {
  const f = await evolutionFixture(t); const r = await registry(); const { evolve } = await import('../src/evolution.mjs');
  const args = { ...f, sessionId: f.source.sessionId, runId: f.source.runId, skill: 'inventory', maxRequests: 20, autoPromote: false };
  const a = await evolve(args), b = await evolve(args);
  await r.promote(f.cwd, b.candidate.id);
  await assert.rejects(r.promote(f.cwd, a.candidate.id), /CAS/);
  const mod = new URL('../src/skills.mjs', import.meta.url).href;
  const out = await execFile(process.execPath, ['--input-type=module', '-e', `import {discoverSkills,loadSkill} from ${JSON.stringify(mod)}; const d=await discoverSkills(process.argv[1],{skillsDirs:['skills'],userSkills:false}); console.log(JSON.stringify(await loadSkill(d.skills.get('inventory'))));`, f.cwd]);
  assert.equal(JSON.parse(out.stdout).hash, b.candidate.hash);
  await fs.mkdir(path.join(f.cwd, '.eve/evolution/publish.lock'));
  await assert.rejects(r.rollback(f.cwd, 'inventory'), /锁/);
  await fs.rmdir(path.join(f.cwd, '.eve/evolution/publish.lock'));
});

test('tampered evaluation hash is rejected without changing active', async t => {
  const f = await evolutionFixture(t); const r = await registry(); const { evolve } = await import('../src/evolution.mjs');
  const result = await evolve({ ...f, sessionId: f.source.sessionId, runId: f.source.runId, skill: 'inventory', maxRequests: 20, autoPromote: false });
  const file = path.join(f.cwd, '.eve/evolution/evaluations', result.evaluationHash + '.json');
  const evidence = JSON.parse(await fs.readFile(file, 'utf8')); evidence.cases[0].candidate.passed = false;
  await fs.writeFile(file, JSON.stringify(evidence));
  await assert.rejects(r.promote(f.cwd, result.candidate.id), /评测/);
  assert.equal((await r.capabilities(f.cwd)).active.inventory, f.baseline.hash);
});

test('auto evolution makes at most one candidate and never rewrites original task output', async t => {
  const f = await evolutionFixture(t); const { autoEvolve } = await import('../src/evolution.mjs');
  const before = await fs.readFile(path.join(f.cwd, 'out.json'), 'utf8');
  const args = { ...f, skill: 'inventory', maxRequests: 20 };
  const result = await autoEvolve({ ...args, result: f.source });
  assert.equal(result.status, 'promoted');
  assert.equal(f.captures.filter(r => !r.tools).length, 1);
  assert.equal(await fs.readFile(path.join(f.cwd, 'out.json'), 'utf8'), before);
  assert.equal((await autoEvolve({ ...args, result: { verification: { status: 'passed' } } })).status, 'not_triggered');
  assert.equal(f.captures.filter(r => !r.tools).length, 1);
});

test('incomplete evaluation without real skill load is rejected even if artifacts are claimed correct', async t => {
  const f = await evolutionFixture(t); const { evolve } = await import('../src/evolution.mjs'); const r = await registry();
  const original = f.fetchImpl;
  const fetchImpl = async (url, init) => JSON.parse(init.body).tools ? response({ content: 'All cases passed.' }) : original(url, init);
  const result = await evolve({ ...f, fetchImpl, sessionId: f.source.sessionId, runId: f.source.runId, skill: 'inventory', maxRequests: 20 });
  assert.equal(result.status, 'rejected');
  assert.ok(result.evaluation.cases.every(c => !c.baseline.certain && !c.candidate.passed));
  assert.equal((await r.capabilities(f.cwd)).active.inventory, f.baseline.hash);
});

test('invalid generator frontmatter consumes a finite attempt and never changes active', async t => {
  const f = await evolutionFixture(t); const { evolve } = await import('../src/evolution.mjs'); const r = await registry();
  const args = { ...f, fetchImpl: async () => response({ content: 'Not a skill' }), sessionId: f.source.sessionId, runId: f.source.runId, skill: 'inventory', maxRequests: 20 };
  await assert.rejects(evolve(args), /frontmatter/);
  await assert.rejects(evolve(args), /frontmatter/);
  await assert.rejects(evolve(args), /谱系/);
  assert.equal((await r.capabilities(f.cwd)).active.inventory, f.baseline.hash);
});

test('CLI one-command auto evolve promotes for next run, keeps source failure and does not replay', async t => {
  const { createServer } = await import('node:http');
  const f = await evolutionFixture(t); const capture = [], serveModel = modelMock(capture);
  const server = createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    const answer = await serveModel('', { body }); res.setHeader('Content-Type', 'application/json'); res.end(await answer.text());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await fs.writeFile(path.join(f.cwd, '.eve/config.json'), JSON.stringify({ userSkills: false, maxSteps: 4 }));
  const cli = path.resolve(import.meta.dirname, '../bin/eve.mjs');
  let result;
  try {
    await execFile(process.execPath, [cli, 'run', '--cwd', f.cwd, '--prompt', 'Build inventory from in.txt into out.json', '--contract', 'source-contract.json', '--auto-evolve', '--skill', 'inventory', '--suite', 'suite.json', '--max-requests', '20', '--json'], { env: { ...process.env, EVE_CONFIG: '', EVE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, EVE_API_KEY: '', EVE_MAX_STEPS: '4' } });
    assert.fail('source failure must retain nonzero exit');
  } catch (e) { result = e; }
  // First invocation intentionally has no contract file: no model request is authorized.
  assert.equal(capture.length, 0);
  assert.equal(JSON.parse(result.stdout).status, 'failed');
  await fs.writeFile(path.join(f.cwd, 'source-contract.json'), JSON.stringify(contract(['x'])));
  try {
    await execFile(process.execPath, [cli, 'run', '--cwd', f.cwd, '--prompt', 'Build inventory from in.txt into out.json', '--contract', 'source-contract.json', '--auto-evolve', '--skill', 'inventory', '--suite', 'suite.json', '--max-requests', '20', '--json'], { env: { ...process.env, EVE_CONFIG: '', EVE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, EVE_API_KEY: '', EVE_MAX_STEPS: '4' } });
    assert.fail('source failure must retain nonzero exit');
  } catch (e) { result = e; }
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, 'failed');
  assert.equal(out.evolution.status, 'promoted');
  assert.equal(out.evolution.nextTaskOnly, true);
  assert.equal(capture.filter(r => !r.tools).length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.cwd, 'out.json'), 'utf8')).items, [' x ', '']);
});

test('new runs expire historical skill bodies and require loading the current snapshot', async t => {
  const f = await evolutionFixture(t); const r = await registry(); const { evolve } = await import('../src/evolution.mjs'); const { runSession } = await import('../src/sessions.mjs');
  const evolved = await evolve({ ...f, sessionId: f.source.sessionId, runId: f.source.runId, skill: 'inventory', maxRequests: 20 });
  let first;
  await runSession({ cwd: f.cwd, config: f.config, sessionId: f.source.sessionId, prompt: 'Continue with current skill', fetchImpl: async (_url, init) => { first = JSON.parse(init.body); return response({ content: 'done' }); } });
  assert.ok(!first.messages.some(m => m.role === 'tool' && m.content.includes('old instructions')));
  assert.ok(first.messages.some(m => m.role === 'tool' && m.content.includes('expired')));
  assert.ok(first.messages[0].content.includes(evolved.candidate.hash));
  await r.rollback(f.cwd, 'inventory');
});

test('auto suite frozen before the task cannot be replaced by workspace writes', async t => {
  const f = await evolutionFixture(t); const { freezeSuite, autoEvolve } = await import('../src/evolution.mjs');
  assert.equal(typeof freezeSuite, 'function');
  const frozenSuite = await freezeSuite(f.cwd, f.suiteFile);
  await fs.writeFile(path.join(f.cwd, f.suiteFile), '{}');
  const result = await autoEvolve({ ...f, frozenSuite, result: f.source, skill: 'inventory', maxRequests: 20 });
  assert.equal(result.status, 'promoted');
  assert.equal(result.evaluation.suiteHash, frozenSuite.suiteHash);
});

test('evaluation timeouts are uncertainty and ordinary tools cannot read registry evidence', async t => {
  const f = await evolutionFixture(t); const { evolve } = await import('../src/evolution.mjs'); const r = await registry();
  const raw = JSON.parse(await fs.readFile(path.join(f.cwd, 'suite.json'), 'utf8')); raw.budget.timeoutMs = 30;
  await fs.writeFile(path.join(f.cwd, 'suite.json'), JSON.stringify(raw));
  const original = f.fetchImpl;
  const result = await evolve({ ...f, fetchImpl: (url, init) => JSON.parse(init.body).tools ? new Promise(() => {}) : original(url, init), sessionId: f.source.sessionId, runId: f.source.runId, skill: 'inventory', maxRequests: 20 });
  assert.equal(result.status, 'rejected');
  assert.ok(result.evaluation.cases.every(c => !c.baseline.certain && !c.candidate.certain));
  assert.equal((await r.capabilities(f.cwd)).active.inventory, f.baseline.hash);
  const tools = await createTools(f.cwd, await discoverSkills(f.cwd, f.config), f.config);
  await assert.rejects(tools('read_file', JSON.stringify({ path: '.eve/evolution/state.json' })), /保护/);
  await assert.rejects(tools('load_skill', JSON.stringify({ name: result.candidate.id })), /未发现/);
});
