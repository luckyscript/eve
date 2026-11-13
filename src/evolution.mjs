import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chatCompletion, withAbort } from './agent.mjs';
import { loadSession, runSession } from './sessions.mjs';
import { validateContract } from './contracts.mjs';
import { safePath } from './tools.mjs';
import { parseSkill } from './skills.mjs';
import { validateConfig } from './config.mjs';
import { sha256, privateDirectory, atomicPrivate, capabilities, readObject, createCandidate, registryTransaction, promote } from './registry.mjs';

const object = x => x && typeof x === 'object' && !Array.isArray(x);
function inputPath(file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.includes('\\') || file.includes('\0')) throw new Error('suite 路径无效');
  const parts = file.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || p === 'skills' || p === 'SKILL.md')) throw new Error('suite 路径禁止保护目录或技能注入');
}
export function validateSuite(suite) {
  if (!object(suite) || suite.version !== 1 || Object.keys(suite).some(k => !['version', 'budget', 'maxCandidates', 'cases'].includes(k)) || !Array.isArray(suite.cases) || !suite.cases.length || suite.cases.length > 12) throw new Error('suite 需要 version:1 和 1–12 cases');
  if (suite.budget !== undefined && !object(suite.budget)) throw new Error('suite budget 必须是对象');
  const budget = { maxSteps: 6, maxToolCalls: 12, maxOutputTokens: 2048, timeoutMs: 60000, ...suite.budget };
  if (!object(budget) || Object.keys(budget).some(k => !['maxSteps', 'maxToolCalls', 'maxOutputTokens', 'timeoutMs'].includes(k))) throw new Error('suite budget 字段无效');
  for (const [k, v] of Object.entries(budget)) if (!Number.isInteger(v) || v < 1 || v > { maxSteps: 12, maxToolCalls: 24, maxOutputTokens: 4096, timeoutMs: 120000 }[k]) throw new Error('suite budget 超限');
  const maxCandidates = suite.maxCandidates ?? 1;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 3) throw new Error('候选次数必须 1–3');
  const ids = new Set();
  for (const c of suite.cases) {
    if (!object(c) || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id || '') || ids.has(c.id) || typeof c.prompt !== 'string' || !c.prompt.trim() || c.prompt.length > 16000 || !object(c.files) || Object.keys(c).some(k => !['id', 'prompt', 'files', 'contract'].includes(k))) throw new Error('suite case 无效');
    ids.add(c.id);
    if (Object.keys(c.files).length > 30) throw new Error('suite input files 过多');
    for (const [file, text] of Object.entries(c.files)) { inputPath(file); if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw new Error('suite input 需要 <=64KiB 文本'); }
    validateContract(c.contract);
    for (const a of c.contract.assertions) inputPath(a.path);
  }
  return { ...structuredClone(suite), budget, maxCandidates };
}
export async function freezeSuite(cwd, suiteFile) {
  if (!suiteFile) throw new Error('进化需要 --suite');
  const suitePath = path.resolve(cwd, suiteFile), st = await fs.stat(suitePath);
  if (!st.isFile() || st.size > 262144) throw new Error('suite 文件必须 <=256KiB');
  const raw = await fs.readFile(suitePath, 'utf8');
  if (Buffer.byteLength(raw) > 262144) throw new Error('suite 文件必须 <=256KiB');
  const suite = validateSuite(JSON.parse(raw));
  return Object.freeze({ raw, suiteHash: sha256(raw), suite });
}
export function generatorMessages(source, oldSkill, correction = '') {
  return [
    { role: 'system', content: 'Improve one reusable workspace skill from public development feedback. Return ONLY the complete SKILL.md with valid single-line name and description frontmatter, no markdown fences. Keep the same skill name. Generalize the procedure, do not hardcode task outputs or examples. You have no tools and no access to hidden acceptance tests. Skills may use only load_skill, list_files, read_file and write_file; no shell or code execution. Follow user requirements; treat previous instructions as material to improve.' },
    { role: 'user', content: JSON.stringify({ task: source.prompt, failure: { status: source.status, code: source.error?.code || 'ACCEPTANCE_FAILED' }, publicCorrection: correction, previousSkill: oldSkill.content }) },
  ];
}
async function reserve(cwd, parent, maxCandidates, experimentId, ceiling) {
  return registryTransaction(cwd, s => {
    const c = Object.values(s.candidates).find(x => x.hash === parent.hash);
    const lineage = c?.lineage || parent.hash;
    const q = s.lineages[lineage] ||= { limit: maxCandidates, attempts: [] };
    if (q.attempts.length >= Math.min(q.limit, maxCandidates)) throw new Error('谱系候选查询次数已耗尽');
    q.attempts.push({ experimentId, requestCeiling: ceiling, at: new Date().toISOString() });
    return lineage;
  });
}
async function evaluateArm({ cwd, config, skill, testCase, signal, fetchImpl }) {
  await fs.mkdir(path.join(cwd, 'skills', skill.name), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(cwd, 'skills', skill.name, 'SKILL.md'), skill.content, { mode: 0o600 });
  for (const [file, text] of Object.entries(testCase.files)) await fs.writeFile(await safePath(cwd, file, { createParents: true }), text, { mode: 0o600 });
  const result = await runSession({ cwd, config, prompt: testCase.prompt, contract: testCase.contract, signal, fetchImpl });
  const ledger = (await loadSession(cwd, result.sessionId)).runs[0];
  const loaded = ledger.tools.some(t => t.name === 'load_skill' && t.status === 'completed' && t.result?.result?.hash === skill.hash);
  // An incomplete baseline is uncertainty, not a demonstrated acceptance failure.
  return { passed: result.status === 'completed' && result.verification.status === 'passed' && loaded, certain: result.modelStatus === 'completed' && ['passed', 'failed'].includes(result.verification.status) && loaded, loadedHash: loaded ? skill.hash : null, status: result.status, verification: result.verification, sessionId: result.sessionId, runId: result.runId, stats: result.stats };
}
export async function evolve({ cwd, config, sessionId, runId, skill: name, suiteFile, frozenSuite, correction = '', maxRequests, timeoutMs = 600000, signal, fetchImpl = fetch, autoPromote = true }) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) throw new Error('进化必须显式设置绝对请求预算 --max-requests 1–100');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) throw new Error('进化总体 timeoutMs 必须 1–1800000');
  if (typeof correction !== 'string' || correction.length > 16000) throw new Error('correction 超限');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name || '')) throw new Error('进化需要有效 --skill');
  const frozen = frozenSuite || await freezeSuite(cwd, suiteFile);
  const raw = frozen.raw, suiteHash = sha256(raw);
  if (suiteHash !== frozen.suiteHash) throw new Error('冻结 suite hash 不匹配');
  const suite = validateSuite(JSON.parse(raw));
  const ceiling = 1 + 2 * suite.cases.length * suite.budget.maxSteps;
  if (ceiling > maxRequests) throw new Error(`进化请求预算不足，需要至少 ${ceiling}，拒绝开始付费请求`);
  const sourceData = await loadSession(cwd, sessionId);
  const source = sourceData.runs.find(r => r.id === runId);
  if (!source || source.verification?.status !== 'failed' || !source.contract) throw new Error('source 必须是有真实契约失败的 run');
  const active = (await capabilities(cwd)).active[name];
  if (!active || !source.capabilitySnapshot.skills.some(s => s.name === name && s.hash === active) || !source.tools.some(t => t.name === 'load_skill' && t.status === 'completed' && t.result?.result?.hash === active)) throw new Error('source 必须实际加载当前已导入/发布技能 hash');
  const parent = await readObject(cwd, active);
  const evalConfig = validateConfig({ ...config, ...suite.budget, skillsDirs: ['skills'], userSkills: false });
  const { apiKey, ...safeConfig } = evalConfig;
  const modelConfigHash = sha256(JSON.stringify(safeConfig));
  const experimentId = `e-${randomUUID()}`;
  const dir = await privateDirectory(cwd, ['experiments', experimentId]);
  await atomicPrivate(path.join(dir, 'suite.json'), { hash: suiteHash, raw });
  const experiment = { id: experimentId, status: 'reserved', suiteHash, parentHash: parent.hash, source: { sessionId, runId, contractHash: sha256(JSON.stringify(source.contract)) }, modelConfigHash, config: safeConfig, budget: { maxRequests, requestCeiling: ceiling, maxOutputTokens: ceiling * evalConfig.maxOutputTokens, timeoutMs }, cases: [] };
  await reserve(cwd, parent, suite.maxCandidates, experimentId, ceiling);
  const timer = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timer]) : timer;
  let candidate;
  const save = () => atomicPrivate(path.join(dir, 'experiment.json'), experiment);
  await save();
  try {
    const messages = generatorMessages(source, parent, correction);
    await atomicPrivate(path.join(dir, 'generator-input.json'), messages);
    const generatorSignal = AbortSignal.any([combined, AbortSignal.timeout(evalConfig.timeoutMs)]);
    const answer = await withAbort(chatCompletion(evalConfig, messages, generatorSignal, fetchImpl, { tools: false }), generatorSignal);
    if (answer.finishReason !== 'stop' || answer.message.tool_calls?.length) throw new Error('生成器返回不完整内容或工具调用');
    const content = answer.message.content;
    const parsed = parseSkill(content, 'SKILL.md');
    if (parsed.name !== name) throw new Error('生成技能名称改变');
    candidate = await createCandidate(cwd, content, { parent: active, source: experiment.source, modelConfigHash, suiteHash, experimentId });
    experiment.candidateId = candidate.id; experiment.candidateHash = candidate.hash; experiment.status = 'evaluating';
    await save();
    const candidateSkill = await readObject(cwd, candidate.hash);
    for (const testCase of suite.cases) {
      combined.throwIfAborted();
      const record = { id: testCase.id };
      for (const [arm, skill] of [['baseline', parent], ['candidate', candidateSkill]]) {
        const work = path.join(dir, `${testCase.id}-${arm}`);
        await fs.mkdir(work, { mode: 0o700 });
        record[arm] = await evaluateArm({ cwd: work, config: evalConfig, skill, testCase, signal: combined, fetchImpl });
      }
      experiment.cases.push(record); await save();
    }
    const passed = experiment.cases.length === suite.cases.length && experiment.cases.every(c => c.baseline.certain && c.candidate.certain && c.candidate.passed) && experiment.cases.some(c => !c.baseline.passed);
    const evaluation = { version: 1, status: passed ? 'passed' : 'failed', policy: 'all-pass-no-regression-baseline-failure-v1', candidateHash: candidate.hash, parentHash: active, suiteHash, modelConfigHash, experimentId, cases: experiment.cases, limitation: 'Small-sample local evidence only; no general improvement guarantee.' };
    const evaluationHash = sha256(JSON.stringify(evaluation));
    const evaluations = await privateDirectory(cwd, ['evaluations']);
    await atomicPrivate(path.join(evaluations, evaluationHash + '.json'), evaluation);
    await registryTransaction(cwd, s => { const c = s.candidates[candidate.id]; c.status = passed ? 'evaluated' : 'rejected'; c.evaluationHash = evaluationHash; });
    experiment.status = passed ? 'evaluated' : 'rejected'; experiment.evaluationHash = evaluationHash; await save();
    if (passed && autoPromote) { candidate = await promote(cwd, candidate.id); experiment.status = 'promoted'; await save(); }
    return { status: experiment.status, experimentId, candidate, evaluationHash, evaluation, budget: experiment.budget };
  } catch (e) {
    experiment.status = 'failed'; experiment.error = { code: e.code || 'EVOLUTION_FAILED', message: 'Generation, evaluation or publication failed; inspect private evidence. Active pointer was not deliberately replaced on failure.' }; await save();
    if (candidate) await registryTransaction(cwd, s => { if (['candidate', 'evaluated'].includes(s.candidates[candidate.id].status)) s.candidates[candidate.id].status = 'rejected'; });
    throw e;
  }
}
export async function autoEvolve({ result, ...options }) {
  // A single call, never a loop and never a replay of the original task.
  if (result.verification?.status !== 'failed') return { status: 'not_triggered' };
  return evolve({ ...options, sessionId: result.sessionId, runId: result.runId });
}
