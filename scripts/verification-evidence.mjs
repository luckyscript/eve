import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const hash = x => createHash('sha256').update(x).digest('hex');
export async function sourceEvidence(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const files = git(['ls-files', 'src', 'bin', 'scripts', 'skills', 'test', 'package.json', 'package-lock.json']).split('\n').filter(Boolean).sort();
  const digests = {};
  for (const file of files) digests[file] = hash(await fs.readFile(path.join(root, file)));
  return { head: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain']), digest: hash(JSON.stringify(digests)), digests };
}
export async function requestEvidence() {
  const file = process.env.EVE_REQUEST_AUDIT;
  if (!file) throw new Error('Live verification requires EVE_REQUEST_AUDIT (absolute private JSONL)');
  const text = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  const requests = text.trim() ? text.trim().split('\n').map(x => JSON.parse(x)) : [];
  return { total: requests.length, digest: hash(text), requests };
}
