// Explicit opt-in live acceptance. Uses the packaged core; shares an 8-request
// private ledger with the optional isolated UI pass. Never logs credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
const root = path.resolve(import.meta.dirname, '..');
const app = path.join(root, 'dist/Eve.app');
const revision = (await fs.readFile(path.join(app, 'Contents/Resources/source-revision.txt'), 'utf8')).trim();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(revision, head, 'build a clean application from the current commit first');
const { BridgeHost } = await import(pathToFileURL(path.join(app, 'Contents/Resources/bridge/Bridge/host.mjs')));
await fs.mkdir(path.join(root, '.eve/runs'), { recursive: true });
const fixture = await fs.mkdtemp(path.join(root, '.eve/verify-macos-ux-live-'));
const keep = process.argv.includes('--keep-ui');
let host;
let successful = false;
try {
  const config = await loadConfig({ cwd: root });
  await fs.mkdir(path.join(fixture, '.eve'), { mode: 0o700 });
  await fs.writeFile(path.join(fixture, '.eve/config.local.json'), JSON.stringify({ ...config, maxSteps: 4, maxToolCalls: 4, maxOutputTokens: 700, timeoutMs: 90000, skillsDirs: [], userSkills: false }), { mode: 0o600 });
  await fs.writeFile(path.join(fixture, '.gitignore'), '/.eve/\n');
  const marker = `native-ux-${randomUUID()}`;
  await fs.writeFile(path.join(fixture, 'proof.txt'), marker);
  await fs.writeFile(path.join(fixture, 'acceptance.json'), JSON.stringify({ version: 1, assertions: [{ type: 'sha256_equals', path: 'proof.txt', sha256: createHash('sha256').update(marker).digest('hex') }] }));
  // The copied, validated settings are the sole model configuration for this fixture.
  for (const key of Object.keys(process.env)) if (key.startsWith('EVE_')) delete process.env[key];
  const ledger = path.join(fixture, '.eve/live-requests.jsonl');
  process.env.EVE_REQUEST_AUDIT = ledger;
  process.env.EVE_REQUEST_LIMIT = '8';
  const events = [];
  let generationRequests = 0, sseResponses = 0;
  host = new BridgeHost({
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/chat/completions')) generationRequests++;
      const response = await fetch(url, options);
      if (response.headers.get('content-type')?.includes('text/event-stream')) sseResponses++;
      return response;
    },
    onEvent: (_id, e) => events.push({ type: e.type, name: e.name, text: e.type === 'assistant_delta' ? e.text : undefined, at: Date.now() })
  });
  await host.call('workspace', { path: fixture }, 'ux-live-workspace');
  const connection = await host.call('connection.test', {}, 'ux-live-connection');
  const run = await host.call('run', { sessionId: 'ux-live-proof', stream: true, contractFile: 'acceptance.json', prompt: '必须调用 read_file 读取 proof.txt。不要修改任何文件。然后用 Markdown 标题和一个围栏代码块展示文件里的完整字符串，最后用一句中文说明已读取。' }, 'ux-live-run');
  assert.equal(run.status, 'completed');
  assert.equal(run.verification.status, 'passed');
  assert(events.some(e => e.type === 'tool_end' && e.name === 'read_file'));
  assert(run.final.includes(marker));
  assert.equal(await fs.readFile(path.join(fixture, 'proof.txt'), 'utf8'), marker);
  const deltas = events.filter(e => e.type === 'assistant_delta');
  assert(deltas.length > 0);
  const requests = (await fs.readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean).length;
  assert(requests <= 8);
  const report = {
    source: head, packagedCore: true, fixture: keep ? fixture : null, keepUIFixture: keep,
    requestLimit: 8, requests, generationRequests, sseResponses, deltaEvents: deltas.length,
    firstDeltaBeforeLastEvent: deltas[0].at <= events.at(-1).at,
    connection: { ok: connection.ok, modelCount: connection.models?.length ?? 0 },
    run: { status: run.status, modelStatus: run.modelStatus, verification: run.verification.status, readToolObserved: true },
    sessionId: 'ux-live-proof', at: new Date().toISOString()
  };
  await fs.writeFile(path.join(root, '.eve/runs/macos-ux-live.json'), JSON.stringify(report, null, 2));
  successful = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await host?.shutdown();
  if (!keep || !successful) await fs.rm(fixture, { recursive: true, force: true });
}
