import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAgent } from './agent.mjs';
import { loadContract, validateContract, verifyContract } from './contracts.mjs';
import { messageHash } from './context.mjs';
import { TOOL_SCHEMAS } from './tools.mjs';

export function validateSessionId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error('会话 ID 必须为 1–64 位字母数字、下划线或连字符，首位须为字母数字');
  return id;
}
export const newSessionId = () => `s-${randomUUID()}`;
const now = () => new Date().toISOString();
async function directory(cwd) {
  let dir = await fs.realpath(cwd);
  for (const part of ['.eve', 'sessions']) {
    dir = path.join(dir, part);
    await fs.mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('会话状态目录禁止符号链接');
  }
  await fs.chmod(dir, 0o700);
  return dir;
}
async function regular(file) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('会话状态必须是普通文件');
}
async function syncDirectory(dir) {
  const h = await fs.open(dir, 'r');
  try { await h.sync(); } finally { await h.close(); }
}
async function atomic(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const h = await fs.open(temp, 'wx', 0o600);
    try { await h.writeFile(JSON.stringify(data) + '\n'); await h.sync(); } finally { await h.close(); }
    await fs.rename(temp, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temp, { force: true }); }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('锁所有者无效，需人工检查');
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; return true; }
}
async function acquire(dir, id) {
  const lock = path.join(dir, `${id}.lock`);
  const candidate = path.join(dir, `${id}.${randomUUID()}.lock-tmp`);
  const token = randomUUID();
  // Publish a nonempty directory atomically: no ownerless-lock crash window.
  await fs.mkdir(candidate, { mode: 0o700 });
  await fs.writeFile(path.join(candidate, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await fs.rename(candidate, lock); return async () => {
        const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
        if (owner.token !== token) throw new Error('会话锁所有者发生变化');
        const retired = `${lock}.${randomUUID()}.retired`;
        await fs.rename(lock, retired);
        await fs.rm(retired, { recursive: true });
      }; } catch (e) { if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e; }
      const st = await fs.lstat(lock);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('会话锁路径无效');
      // Only one reaper can inspect/remove a dead owner's lock at a time.
      const reaper = `${lock}.reap`;
      await fs.mkdir(reaper, { mode: 0o700 }).catch(() => { throw new Error('会话锁正在恢复，稍后再试'); });
      try {
        await regular(path.join(lock, 'owner.json'));
        const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
        if (alive(owner.pid)) throw new Error('会话被其他写者占用（锁）');
        const retired = `${lock}.${randomUUID()}.retired`;
        await fs.rename(lock, retired);
        await fs.rm(retired, { recursive: true });
      } finally { await fs.rmdir(reaper); }
    }
    throw new Error('会话锁竞争，请重试');
  } finally { await fs.rm(candidate, { recursive: true, force: true }); }
}
function recover(data) {
  let changed = false;
  for (const run of data.runs) if (run.status === 'running') {
    run.status = 'interrupted';
    if (!run.modelStatus || run.modelStatus === 'running') run.modelStatus = 'interrupted';
    run.endedAt = now();
    for (const tool of run.tools || []) if (tool.status === 'intent') tool.status = 'unknown';
    run.events.push({ type: 'recovered_interruption', at: now(), noReplay: true });
    changed = true;
  }
  return changed;
}
export async function openSession(cwd, id, { create = true } = {}) {
  validateSessionId(id);
  const dir = await directory(cwd);
  const release = await acquire(dir, id);
  const file = path.join(dir, `${id}.json`);
  try {
    let data, created = false;
    try {
      await regular(file);
      try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new Error('会话账本 JSON 损坏，原记录保持不变'); }
      if (data.version !== 1 || data.id !== id || !Array.isArray(data.runs) || data.runs.some(r => !Array.isArray(r.messages) || !Array.isArray(r.events))) throw new Error('会话账本格式无效');
    } catch (e) {
      if (e.code !== 'ENOENT' || !create) throw e;
      created = true;
      data = { version: 1, id, createdAt: now(), updatedAt: now(), runs: [] };
    }
    const changed = recover(data);
    let closed = false;
    const session = { data, async save() {
      if (closed) throw new Error('会话已关闭');
      data.updatedAt = now(); await atomic(file, data);
    }, async close() { if (!closed) { closed = true; await release(); } } };
    if (changed || created) await session.save();
    return session;
  } catch (e) { await release(); throw e; }
}
export async function loadSession(cwd, id) {
  const session = await openSession(cwd, id, { create: false });
  try { return structuredClone(session.data); } finally { await session.close(); }
}
export async function listSessions(cwd) {
  const dir = await directory(cwd);
  const items = [];
  for (const file of (await fs.readdir(dir)).sort()) if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.json$/.test(file)) {
    const id = file.slice(0, -5);
    try { const data = await loadSession(cwd, id); items.push({ id, runs: data.runs.length, status: data.runs.at(-1)?.status || 'new', updatedAt: data.updatedAt }); }
    catch { items.push({ id, status: 'unavailable' }); }
  }
  return items;
}
export function sessionHistory(data) {
  const run = data.runs.findLast(r => r.messages.length);
  const context = data.context?.baseRunId === run?.id ? data.context : run?.context;
  const tail = context && Number.isInteger(context.rawCount) ? (run?.messages || []).slice(context.rawCount) : [];
  const messages = structuredClone(context ? [...context.view, ...tail] : run?.messages || []).filter(m => m.role !== 'system');
  // Repair protocol in a derived view only; the raw interrupted evidence stays intact.
  const history = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    history.push(m);
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const results = new Map();
      while (messages[i + 1]?.role === 'tool') { const result = messages[++i]; results.set(result.tool_call_id, result); }
      for (const call of m.tool_calls) history.push(results.get(call.id) || { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, status: 'unknown', error: '进程中断，工具结果未知；未自动重放。核验实际产物后再决定下一步。' }) });
    }
  }
  if (run && run.status !== 'completed') history.push({ role: 'user', content: `[eve host] 上轮状态 ${run.status}，验收 ${run.verification?.status || 'not_checked'}。已写入产物未回滚，工具不会自动重放。请按新任务指令继续并核验产物。` });
  return history;
}
export async function runSession({ cwd = process.cwd(), config, sessionId = newSessionId(), contractFile, contract: inputContract, ...options }) {
  const contract = contractFile ? await loadContract(cwd, contractFile) : inputContract ? validateContract(inputContract) : null;
  // Validate all target paths before granting the model any write opportunity.
  if (contract) await verifyContract(cwd, contract);
  const session = await openSession(cwd, sessionId);
  try {
    const previous = session.data.runs.findLast(r => r.messages.length);
    const derived = session.data.context?.baseRunId === previous?.id ? session.data.context : previous?.context;
    const history = sessionHistory(session.data);
    const tailSources = derived && Number.isInteger(derived.rawCount) ? (previous?.messages || []).slice(derived.rawCount).map((m, i) => ({ runId: previous.id, index: derived.rawCount + i, sha256: messageHash(m) })) : [];
    const sources = derived ? [...derived.sources, ...tailSources] : (previous?.messages || []).flatMap((m, index) => m.role === 'system' ? [] : [{ runId: previous.id, index, sha256: messageHash(m) }]);
    const run = { id: `r-${randomUUID()}`, startedAt: now(), status: 'running', modelStatus: 'running', prompt: options.prompt, contract, capabilitySnapshot: { runtime: 'eve-native-v1', node: process.version, model: config.model, tools: TOOL_SCHEMAS, skills: [] }, messages: [], responses: [], events: [], tools: [] };
    session.data.runs.push(run); await session.save();
    const result = await runAgent({ ...options, cwd, config, history, contract, runId: run.id, contextSummary: derived?.summary, contextSources: sources, previousSkills: previous?.capabilitySnapshot?.skills, onCheckpoint: async ({ messages, events, event, details }) => {
      run.messages = structuredClone(messages); run.events = structuredClone(events);
      if (event.type === 'context_ready') run.systemMessage = structuredClone(details.system);
      if (event.type === 'context_summary') { run.summaries ||= []; run.summaries.push(structuredClone(details.summary)); run.context = structuredClone(details.context); }
      if (event.type === 'model_response') run.responses.push(structuredClone(details.answer));
      if (event.type === 'run_end') run.modelStatus = event.status;
      if (event.type === 'capability_snapshot') run.capabilitySnapshot.skills = details.skills;
      if (event.type === 'tool_intent') {
        let args = null; try { args = JSON.parse(details.arguments); } catch { /* Keep malformed raw input as evidence. */ }
        run.tools.push({ callId: event.callId, name: event.name, rawArguments: details.arguments, arguments: args, status: 'intent', at: now() });
      }
      if (event.type === 'tool_end') {
        const tool = run.tools.findLast(t => t.callId === event.callId && t.status === 'intent');
        if (tool) { tool.status = details.notExecuted ? 'not_executed' : details.unknown ? 'unknown' : details.result.ok ? 'completed' : 'failed'; tool.result = details.result; }
      }
      await session.save();
    } });
    run.modelStatus = result.status;
    for (const tool of run.tools) if (tool.status === 'intent') tool.status = 'unknown';
    run.messages = result.messages;
    if (result.context) run.context = result.context;
    let verification = { status: 'not_requested', assertions: [] };
    if (contract) {
      if (result.status !== 'completed') verification = { status: 'not_checked', assertions: [] };
      else try { verification = await verifyContract(cwd, contract, { tools: run.tools }); }
      catch { verification = { status: 'failed', reason: 'unsafe_or_unreadable_target', assertions: [] }; }
    }
    const status = verification.status === 'failed' ? 'failed' : result.status;
    const error = verification.status === 'failed' ? { code: 'ACCEPTANCE_FAILED', message: '模型已结束，但独立产物验收失败；证据保存在本地会话账本。' } : result.error;
    Object.assign(run, { status, endedAt: now(), verification, stats: result.stats, final: result.final, ...(error ? { error } : {}) });
    const acceptanceEvent = { type: 'acceptance_end', modelStatus: result.status, status, verificationStatus: verification.status, at: now() };
    run.events.push(acceptanceEvent);
    await session.save();
    return { ...result, events: [...result.events, acceptanceEvent], status, modelStatus: result.status, verification, sessionId, runId: run.id, ...(error ? { error } : {}) };
  } finally { await session.close(); }
}

// Maintenance compression persists an overlay, never rewrites a prior run's evidence.
export async function compactSession({ cwd = process.cwd(), config, sessionId, ...options }) {
  const session = await openSession(cwd, sessionId, { create: false });
  try {
    const last = session.data.runs.findLast(r => r.messages.length);
    const previous = session.data.context?.baseRunId === last?.id ? session.data.context : last?.context;
    const result = await runAgent({ ...options, cwd, config, history: sessionHistory(session.data), compactOnly: true,
      contextSummary: previous?.summary, contextSources: previous?.sources || (last?.messages || []).flatMap((m, index) => m.role === 'system' ? [] : [{ runId: last.id, index, sha256: messageHash(m) }]), previousSkills: last?.capabilitySnapshot?.skills, runId: `compact-${randomUUID()}`,
      onCheckpoint: async ({ event, details }) => {
        if (event.type === 'context_summary') {
          session.data.contextEvents ||= [];
          session.data.contextEvents.push({ ...event, at: now(), summary: details.summary, baseRunId: last?.id });
          session.data.context = { ...details.context, rawCount: last?.messages.length || 0, baseRunId: last?.id };
          await session.save();
        }
      } });
    if (result.status === 'completed') { session.data.context = { ...result.context, rawCount: last?.messages.length || 0, baseRunId: last?.id }; await session.save(); }
    return { ...result, sessionId };
  } finally { await session.close(); }
}
export async function sessionStatus(cwd, sessionId, config) {
  let data;
  try { data = await loadSession(cwd, sessionId); } catch (e) { if (e.code !== 'ENOENT') throw e; return { sessionId, runs: 0, contextMaxChars: config.contextMaxChars, summary: false }; }
  const run = data.runs.at(-1);
  const context = data.context?.baseRunId === run?.id ? data.context : run?.context;
  return { sessionId, runs: data.runs.length, status: run?.status || 'new', contextChars: context?.chars || 0, contextMaxChars: config.contextMaxChars, summary: !!context?.summary, summaryMethod: context?.summary?.method, summarizedMessages: context?.summary?.sources?.length || 0, compactions: context?.compactions || 0 };
}
