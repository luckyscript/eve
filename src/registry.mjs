import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseSkill } from './skills.mjs';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
const validHash = h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);
export async function privateDirectory(cwd, parts = []) {
  let dir = await fs.realpath(cwd);
  for (const part of ['.eve', 'evolution', ...parts]) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === '..') throw new Error('私有目录名称无效');
    dir = path.join(dir, part);
    await fs.mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('registry 目录禁止符号链接');
    await fs.chmod(dir, 0o700);
  }
  return dir;
}
export async function readPrivate(file) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 16777216) throw new Error('registry 对象必须是受限普通文件');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function atomicPrivate(file, data, { signal } = {}) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const h = await fs.open(temp, 'wx', 0o600);
    try { await h.writeFile(JSON.stringify(data) + '\n'); await h.sync(); } finally { await h.close(); }
    // The rename is the publication commit point. Abort is checked after all awaits before it.
    signal?.throwIfAborted();
    await fs.rename(temp, file);
    const dir = await fs.open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await fs.rm(temp, { force: true }); }
}
async function state(dir) {
  try {
    const s = await readPrivate(path.join(dir, 'state.json'));
    if (s.version !== 1 || !s.active || !s.candidates || !s.lineages) throw new Error('registry 状态无效');
    return s;
  } catch (e) { if (e.code !== 'ENOENT') throw e; return { version: 1, revision: 0, active: {}, candidates: {}, lineages: {} }; }
}
// A crash leaves a lock requiring explicit operator inspection: never steal a possibly live lock.
export async function registryTransaction(cwd, fn, { signal } = {}) {
  const dir = await privateDirectory(cwd), lock = path.join(dir, 'publish.lock');
  await fs.mkdir(lock, { mode: 0o700 }).catch(e => { if (e.code === 'EEXIST') throw new Error('registry 跨进程锁被占用，需检查写者后重试'); throw e; });
  try {
    signal?.throwIfAborted();
    const s = await state(dir), result = await fn(s, dir);
    signal?.throwIfAborted();
    s.revision++; await atomicPrivate(path.join(dir, 'state.json'), s, { signal });
    return result;
  } finally { await fs.rmdir(lock); }
}
export async function capabilities(cwd) {
  return state(await privateDirectory(cwd));
}
async function store(cwd, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 32768) throw new Error('技能内容超出 32 KiB');
  const skill = parseSkill(content, 'SKILL.md');
  const dir = await privateDirectory(cwd, ['objects']);
  const file = path.join(dir, skill.hash + '.json');
  try {
    const h = await fs.open(file, 'wx', 0o600);
    try { await h.writeFile(JSON.stringify({ content }) + '\n'); await h.sync(); } finally { await h.close(); }
  } catch (e) { if (e.code !== 'EEXIST') throw e; await readObject(cwd, skill.hash); }
  return skill;
}
export async function readObject(cwd, hash) {
  if (!validHash(hash)) throw new Error('registry hash 无效');
  const dir = await privateDirectory(cwd, ['objects']);
  const { content } = await readPrivate(path.join(dir, hash + '.json'));
  if (typeof content !== 'string' || sha256(content) !== hash) throw new Error('registry 对象 hash 不匹配');
  return { ...parseSkill(content, 'SKILL.md'), content };
}
export async function importBaseline(cwd, file) {
  const skill = await store(cwd, await fs.readFile(path.resolve(cwd, file), 'utf8'));
  return registryTransaction(cwd, s => {
    if (s.active[skill.name]) throw new Error('已存在 active 技能；baseline 不得绕过评测覆盖');
    s.active[skill.name] = skill.hash;
    const id = `b-${randomUUID()}`;
    s.candidates[id] = { id, name: skill.name, hash: skill.hash, parent: null, lineage: skill.hash, status: 'active', trustedBaseline: true, importedFrom: file };
    return s.candidates[id];
  });
}
export async function createCandidate(cwd, content, metadata) {
  const skill = await store(cwd, content);
  const parent = await readObject(cwd, metadata.parent);
  if (parent.name !== skill.name || parent.hash === skill.hash) throw new Error('候选必须同名且改变技能内容');
  return registryTransaction(cwd, s => {
    if (s.active[skill.name] !== parent.hash) throw new Error('候选 parent CAS 已过期');
    const ancestor = Object.values(s.candidates).find(c => c.hash === parent.hash);
    const id = `c-${randomUUID()}`;
    const c = { ...metadata, id, name: skill.name, hash: skill.hash, parent: parent.hash, lineage: ancestor?.lineage || parent.hash, status: 'candidate', createdAt: new Date().toISOString() };
    s.candidates[id] = c; return structuredClone(c);
  });
}
export async function publishedSkills(cwd) {
  const s = await capabilities(cwd), result = [];
  for (const [name, hash] of Object.entries(s.active)) {
    const object = await readObject(cwd, hash);
    if (object.name !== name) throw new Error('published 技能名称不匹配');
    result.push({ ...object, published: true });
  }
  return result;
}
export async function promote(cwd, id, { signal } = {}) {
  return registryTransaction(cwd, async s => {
    const c = s.candidates[id];
    if (!c || c.status !== 'evaluated' || !c.evaluationHash) throw new Error('候选缺少通过的独立评测');
    const dir = await privateDirectory(cwd, ['evaluations']);
    const e = await readPrivate(path.join(dir, c.evaluationHash + '.json'));
    if (sha256(JSON.stringify(e)) !== c.evaluationHash || e.candidateHash !== c.hash || e.parentHash !== c.parent || e.suiteHash !== c.suiteHash || e.modelConfigHash !== c.modelConfigHash || e.status !== 'passed' || !e.cases?.length || !e.cases.some(x => !x.baseline.passed) || !e.cases.every(x => x.candidate.passed)) throw new Error('独立评测证据无效或未通过');
    await readObject(cwd, c.hash);
    if (s.active[c.name] !== c.parent) throw new Error('发布 parent CAS 冲突');
    signal?.throwIfAborted();
    s.active[c.name] = c.hash; c.status = 'active'; c.promotedAt = new Date().toISOString();
    return structuredClone(c);
  }, { signal });
}
export async function rollback(cwd, name) {
  return registryTransaction(cwd, async s => {
    const current = s.active[name];
    const c = Object.values(s.candidates).findLast(x => x.name === name && x.hash === current && x.status === 'active');
    if (!c?.parent) throw new Error('没有可回滚的已发布版本');
    await readObject(cwd, c.parent);
    s.active[name] = c.parent; c.status = 'revoked'; c.revokedAt = new Date().toISOString();
    return { name, revoked: current, active: c.parent, externalSideEffectsReverted: false };
  });
}
