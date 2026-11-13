import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Optional private, process-shared request ledger. Count attempts before transport,
// including failed requests and summaries; never record keys or prompt bodies.
export async function auditRequest(config, messages, kind) {
  const file = process.env.EVE_REQUEST_AUDIT;
  if (!file) return;
  if (!path.isAbsolute(file)) throw new Error('EVE_REQUEST_AUDIT must be absolute');
  const limit = Number(process.env.EVE_REQUEST_LIMIT || 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid request audit budget');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + '.lock';
  await fs.mkdir(lock, { mode: 0o700 });
  try {
    const previous = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    const count = previous.trim() ? previous.trim().split('\n').length : 0;
    if (count >= limit) throw Object.assign(new Error('Global paid request budget exhausted'), { code: 'REQUEST_BUDGET' });
    await fs.appendFile(file, JSON.stringify({ request: count + 1, at: new Date().toISOString(), pid: process.pid, model: config.model, kind, promptDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') }) + '\n', { mode: 0o600 });
  } finally { await fs.rmdir(lock); }
}
