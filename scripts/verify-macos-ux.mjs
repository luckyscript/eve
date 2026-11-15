// Local deterministic integration checks. No external model or real user workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { BridgeHost } from '../macos/Bridge/host.mjs';
import { openSession } from '../src/sessions.mjs';

const project = path.resolve(import.meta.dirname, '..');
let requestCount = 0;
function request(host, op, params = {}) { return host.call(op, params, `ux-${++requestCount}-${randomUUID()}`); }

test('desktop UX workflow: repair, connection test, session management and bounded history', async t => {
  await fs.mkdir(path.join(project, '.eve'), { recursive: true });
  const root = await fs.mkdtemp(path.join(project, '.eve', 'verify-macos-ux-'));
  const cwd = path.join(root, 'workspace');
  await fs.mkdir(path.join(cwd, '.eve'), { recursive: true, mode: 0o700 });
  const localFile = path.join(cwd, '.eve', 'config.local.json');
  const modelServer = http.createServer((req, res) => {
    if (req.url !== '/v1/models' || req.method !== 'GET') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'ux-local-model' }] }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
  const host = new BridgeHost();
  t.after(async () => {
    await host.shutdown?.();
    await new Promise(resolve => modelServer.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  await t.test('bad local configuration can open diagnostics without blocking settings', async () => {
    await fs.writeFile(localFile, '{"maxSteps":0}', { mode: 0o600 });
    const opened = await request(host, 'workspace', { path: cwd });
    assert.equal(opened.path, cwd);
    const inspected = await request(host, 'config.inspect');
    assert.equal(inspected.valid, false);
    assert(inspected.diagnostics.length > 0);
    assert.equal(inspected.config.apiKey === '' || inspected.config.apiKey === '[not configured]', true);
  });

  await t.test('repair is explicit, validates the replacement and preserves a private backup', async () => {
    await assert.rejects(request(host, 'config.repair', { values: { maxSteps: 12 }, confirm: false }));
    assert.equal(await fs.readFile(localFile, 'utf8'), '{"maxSteps":0}');
    await request(host, 'config.repair', { values: { maxSteps: 12, baseUrl, model: 'ux-local-model', skillsDirs: [], userSkills: false }, confirm: true });
    const inspected = await request(host, 'config.inspect');
    assert.equal(inspected.valid, true);
    assert.equal(inspected.config.maxSteps, 12);
    const stat = await fs.stat(localFile);
    assert.equal(stat.mode & 0o077, 0);
    // The required invariant is an intact private backup, not one particular directory layout.
    async function findOriginal(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory() && await findOriginal(file)) return true;
        if (entry.isFile() && file !== localFile && (await fs.readFile(file, 'utf8')) === '{"maxSteps":0}') {
          assert.equal((await fs.stat(file)).mode & 0o077, 0);
          return true;
        }
      }
      return false;
    }
    assert(await findOriginal(path.join(cwd, '.eve')), 'original invalid configuration must be preserved privately');
  });

  await t.test('connection test lists actual endpoint models without generating an answer', async () => {
    const result = await request(host, 'connection.test');
    assert.equal(result.ok, true);
    assert(result.models.some(m => m.id === 'ux-local-model'));
    assert(Number.isFinite(result.latencyMs));
  });

  const id = 'ux-managed-session';
  await t.test('summary and search work without transferring full session histories', async () => {
    const session = await openSession(cwd, id);
    session.data.runs.push({ id: 'r-ux', prompt: 'Title for UX fixture', final: 'unique-body-search-evidence', status: 'completed', modelStatus: 'completed', messages: [], events: [] });
    await session.save(); await session.close();
    const list = await request(host, 'sessions');
    const summary = list.find(s => s.id === id);
    assert(summary?.title);
    assert.equal(summary.runs == null || typeof summary.runs === 'number', true);
    const searched = await request(host, 'sessions', { query: 'unique-body-search-evidence' });
    assert(searched.some(s => s.id === id));
  });

  await t.test('rename, archive and deletion have explicit safe semantics', async () => {
    await request(host, 'session.rename', { sessionId: id, title: 'Renamed UX conversation' });
    assert.equal((await request(host, 'sessions')).find(s => s.id === id)?.title, 'Renamed UX conversation');
    await request(host, 'session.archive', { sessionId: id, archived: true });
    assert(!(await request(host, 'sessions')).some(s => s.id === id));
    assert((await request(host, 'sessions', { includeArchived: true })).some(s => s.id === id));
    await assert.rejects(request(host, 'session.delete', { sessionId: id, confirm: false }));
    await assert.rejects(request(host, 'session.delete', { sessionId: '../invalid', confirm: true }));
    await request(host, 'session.delete', { sessionId: id, confirm: true });
    assert(!(await request(host, 'sessions', { includeArchived: true })).some(s => s.id === id));
  });

  await t.test('large historical results remain bounded and do not poison subsequent operations', async () => {
    const session = await openSession(cwd, 'ux-large-session');
    for (let i = 0; i < 24; i++) session.data.runs.push({ id: `r-${i}`, prompt: `fixture ${i}`, final: 'public synthetic text '.repeat(6000), status: 'completed', modelStatus: 'completed', messages: [], events: [] });
    await session.save(); await session.close();
    const page = await request(host, 'session.page', { sessionId: 'ux-large-session', limit: 10 });
    assert(Buffer.byteLength(JSON.stringify(page)) < 512 * 1024);
    assert.equal(page.id, 'ux-large-session');
    assert(page.hasMore || page.truncated || page.nextCursor != null);
    assert.equal(page.total, 24);
    assert(Array.isArray(await request(host, 'tools')));
  });

  await t.test('browsing an older session preserves the running task ownership and cancellation', { timeout: 5000 }, async () => {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const active = new BridgeHost({ fetchImpl: async (_url, { signal }) => {
      entered();
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } });
    await request(active, 'workspace', { path: cwd });
    const running = active.call('run', { prompt: 'Synthetic blocked request', sessionId: 'ux-active-run' }, 'ux-active-request');
    try {
      await started;
      const page = await request(active, 'session.page', { sessionId: 'ux-large-session', limit: 1 });
      assert.equal(page.id, 'ux-large-session');
      assert.equal((await request(active, 'busy')).requestID, 'ux-active-request');
      await assert.rejects(request(active, 'session.rename', { sessionId: 'ux-large-session', title: 'Must not mutate during run' }));
      const cancelled = await request(active, 'cancel', { requestID: 'ux-active-request' });
      assert.equal(cancelled.requested, true);
      await running;
    } finally {
      await active.shutdown();
      await running.catch(() => {});
    }
  });
});
