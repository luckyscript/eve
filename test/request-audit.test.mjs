import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { auditRequest } from '../src/request-audit.mjs';

test('request audit counts summary and failed transport attempts without prompt bodies or credentials', async t => {
  const root = path.resolve(import.meta.dirname, '../.eve');
  await fs.mkdir(root, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(root, 'verify-audit-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'requests.jsonl');
  const before = { audit: process.env.EVE_REQUEST_AUDIT, limit: process.env.EVE_REQUEST_LIMIT };
  t.after(() => { for (const [key, value] of [['EVE_REQUEST_AUDIT', before.audit], ['EVE_REQUEST_LIMIT', before.limit]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.EVE_REQUEST_AUDIT = file; process.env.EVE_REQUEST_LIMIT = '2';
  const config = { model: 'test', apiKey: 'PRIVATE_CREDENTIAL' }, messages = [{ role: 'user', content: 'PRIVATE_BODY' }];
  await auditRequest(config, messages, 'summary');
  await auditRequest(config, messages, 'generation');
  await assert.rejects(auditRequest(config, messages, 'task'), { code: 'REQUEST_BUDGET' });
  const raw = await fs.readFile(file, 'utf8'), records = raw.trim().split('\n').map(x => JSON.parse(x));
  assert.equal(records.length, 2); assert.deepEqual(records.map(r => r.kind), ['summary', 'generation']);
  assert(!raw.includes('PRIVATE_BODY')); assert(!raw.includes('PRIVATE_CREDENTIAL'));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});
