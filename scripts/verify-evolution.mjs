import { sourceEvidence, requestEvidence } from './verification-evidence.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { runSession, loadSession } from '../src/sessions.mjs';
import { evolve } from '../src/evolution.mjs';
import { importBaseline, capabilities, rollback, createCandidate, promote, readObject, atomicPrivate, privateDirectory } from '../src/registry.mjs';

const root = path.resolve(import.meta.dirname, '..');
process.env.EVE_REQUEST_AUDIT ||= path.join(root, '.eve/runs', `paid-${Date.now()}.jsonl`);
const sourceStart = await sourceEvidence(root);
const requestsStart = await requestEvidence();
const totalTimeoutMs = Number(process.env.EVE_EVOLUTION_VERIFY_TIMEOUT_MS || 600000);
if (!Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 1000 || totalTimeoutMs > 1800000) throw new Error('EVE_EVOLUTION_VERIFY_TIMEOUT_MS must be 1000–1800000');
const signal = AbortSignal.timeout(totalTimeoutMs);
const report = { version: 1, startedAt: new Date().toISOString(), passed: false, checks: {}, runs: [] };
let cwd;
const task = 'Use the inventory-report skill to produce report.json from inventory.txt. Follow the loaded skill procedure exactly, then read report.json back. Do not edit skills.';
const contract = items => ({ version: 1, assertions: [
  { type: 'json_equals', path: 'report.json', field: ['items'], value: items },
  { type: 'json_equals', path: 'report.json', field: ['count'], value: items.length },
  { type: 'write_readback', path: 'report.json' },
] });
function proof(run) {
  const tools = run.tools.map(t => ({ name: t.name, path: t.arguments?.path, status: t.status, ...(t.name === 'load_skill' ? { hash: t.result?.result?.hash } : {}) }));
  const write = tools.findIndex(t => t.name === 'write_file' && t.status === 'completed');
  const readback = tools.findIndex((t, i) => i > write && t.name === 'read_file' && t.path === 'report.json' && t.status === 'completed');
  return { id: run.id, status: run.status, modelStatus: run.modelStatus, skills: run.capabilitySnapshot.skills, stats: run.stats, verification: run.verification, tools, readback: write >= 0 && readback > write };
}
async function freshProcess(config, workspace, expected) {
  signal.throwIfAborted();
  // Configuration (including authentication) travels only over stdin, never argv or disk.
  const sessions = new URL('../src/sessions.mjs', import.meta.url).href;
  const code = `import {runSession} from ${JSON.stringify(sessions)}; let raw=''; for await(const b of process.stdin) raw+=b; const x=JSON.parse(raw); const r=await runSession(x); console.log(JSON.stringify({sessionId:r.sessionId,runId:r.runId,status:r.status}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.resume(); // Never render provider/configuration errors from children.
  const abort = () => child.kill('SIGTERM'); signal.addEventListener('abort', abort, { once: true });
  child.stdin.end(JSON.stringify({ cwd: workspace, config, prompt: task, contract: contract(expected) }));
  try {
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('fresh-process failed'))); });
    const ids = JSON.parse(output); const ledger = await loadSession(workspace, ids.sessionId);
    return ledger.runs.find(r => r.id === ids.runId);
  } finally { signal.removeEventListener('abort', abort); }
}
try {
  const loaded = await loadConfig({ cwd: root });
  const config = { ...loaded, skillsDirs: ['skills'], userSkills: false, maxSteps: 5, maxToolCalls: 12, maxOutputTokens: 2048, timeoutMs: Math.min(90000, totalTimeoutMs) };
  const privateRoot = await privateDirectory(root, ['verification']);
  cwd = path.join(privateRoot, `v-${randomUUID()}`); await fs.mkdir(cwd, { mode: 0o700 });
  report.workspace = path.relative(root, cwd);
  await fs.mkdir(path.join(cwd, 'skills/inventory-report'), { recursive: true, mode: 0o700 });
  const bodyMarker = `BODY_ONLY_${randomUUID()}`;
  const baselineText = `---\nname: inventory-report\ndescription: Create inventory JSON reports from inventory.txt\n---\nInventory report version 0. ${bodyMarker}\nLoad inventory.txt with read_file. Split its UTF-8 content at every newline (\\n). Each segment, INCLUDING empty segments and whitespace, is one item. Do NOT trim any item and do NOT discard empty items. Preserve duplicates, original Unicode, and order. This literal legacy procedure is required even when the user asks for a report. Write report.json as a JSON object with exactly items (the resulting array of strings) and count (array length). Use write_file, then read_file to verify report.json. No code execution is available.\n`;
  await fs.writeFile(path.join(cwd, 'skills/inventory-report/SKILL.md'), baselineText, { mode: 0o600 });
  const baseline = await importBaseline(cwd, 'skills/inventory-report/SKILL.md');
  report.baselineHash = baseline.hash;
  await fs.writeFile(path.join(cwd, 'inventory.txt'), ' apple \n\n pear\n', { mode: 0o600 });
  console.log('evolution live: running intentionally imperfect baseline');
  const source = await runSession({ cwd, config, prompt: task, contract: contract(['apple', 'pear']), signal });
  const sourceRun = (await loadSession(cwd, source.sessionId)).runs[0];
  report.runs.push({ phase: 'source', ...proof(sourceRun) });
  assert.equal(source.verification.status, 'failed', 'source must fail actual contract');
  assert.ok(sourceRun.tools.some(t => t.name === 'load_skill' && t.result?.result?.hash === baseline.hash));
  report.checks.sourceFailed = true;
  report.checks.metadataOnly = !sourceRun.messages[0].content.includes(bodyMarker) && sourceRun.tools.some(t => t.name === 'load_skill' && t.result?.result?.content.includes(bodyMarker));
  const sourceArtifact = await fs.readFile(path.join(cwd, 'report.json'), 'utf8');
  const hidden = [
    ['blank-space', '  plum \n\n\t mango\t\n   \n', ['plum', 'mango']],
    ['unicode', ' 猫 \n\tCafé\n 龙果  ', ['猫', 'Café', '龙果']],
    ['duplicate-order', 'pear\napple\npear', ['pear', 'apple', 'pear']],
    ['empty', '', []],
  ];
  const suite = { version: 1, maxCandidates: 2, budget: { maxSteps: 5, maxToolCalls: 12, maxOutputTokens: 2048, timeoutMs: config.timeoutMs }, cases: hidden.map(([id, text, items]) => ({ id, files: { 'inventory.txt': text }, prompt: task, contract: contract(items) })) };
  const suiteFile = path.join(cwd, 'hidden-suite.json');
  await fs.writeFile(suiteFile, JSON.stringify(suite), { mode: 0o600 });
  report.suiteHash = (await import('../src/registry.mjs')).sha256(JSON.stringify(suite));
  console.log('evolution live: generating one real candidate; evaluating four hidden cases in both arms');
  const evolution = await evolve({ cwd, config, sessionId: source.sessionId, runId: source.runId, skill: 'inventory-report', suiteFile, correction: 'The inventory report should trim leading and trailing Unicode whitespace from each newline-delimited line, discard all lines empty after trimming, and preserve each remaining string, duplicates and input order. Empty input gives items:[] and count:0. Keep the same JSON output schema and read back after writing. Update the reusable procedure, not any particular input.', maxRequests: 45, timeoutMs: totalTimeoutMs, signal });
  report.evolution = evolution;
  assert.equal(evolution.status, 'promoted', 'insufficient evidence; candidate did not pass all hidden cases');
  report.candidateHash = evolution.candidate.hash;
  report.checks.realGeneratedCandidate = evolution.candidate.hash !== baseline.hash;
  report.checks.comparativePolicy = evolution.evaluation.cases.every(c => c.candidate.passed) && evolution.evaluation.cases.some(c => !c.baseline.passed) && evolution.evaluation.cases.some(c => c.baseline.passed);
  report.checks.noReplay = sourceArtifact === await fs.readFile(path.join(cwd, 'report.json'), 'utf8');
  assert.ok(report.checks.comparativePolicy && report.checks.noReplay);
  console.log('evolution live: checking publication in a fresh process');
  await fs.writeFile(path.join(cwd, 'inventory.txt'), ' kiwi \n\n荔枝\n kiwi\n', { mode: 0o600 });
  const fresh = await freshProcess(config, cwd, ['kiwi', '荔枝', 'kiwi']);
  const freshProof = proof(fresh); report.runs.push({ phase: 'published-fresh-process', ...freshProof });
  const candidateSkill = await readObject(cwd, evolution.candidate.hash);
  report.checks.freshPublished = fresh.status === 'completed' && fresh.verification.status === 'passed' && freshProof.readback && fresh.tools.some(t => t.name === 'load_skill' && t.result?.result?.hash === candidateSkill.hash);
  report.checks.candidateMetadataOnly = !fresh.messages[0].content.includes(candidateSkill.content) && fresh.tools.some(t => t.name === 'load_skill' && t.result?.result?.content === candidateSkill.content);
  assert.ok(report.checks.freshPublished && report.checks.candidateMetadataOnly);
  const beforeRollbackArtifact = await fs.readFile(path.join(cwd, 'report.json'), 'utf8');
  report.rollback = await rollback(cwd, 'inventory-report');
  report.checks.rollbackNoSideEffectUndo = beforeRollbackArtifact === await fs.readFile(path.join(cwd, 'report.json'), 'utf8');
  const reverted = await freshProcess(config, cwd, ['kiwi', '荔枝', 'kiwi']);
  report.runs.push({ phase: 'rollback-fresh-process', ...proof(reverted) });
  report.checks.rollbackLoadedOld = (await capabilities(cwd)).active['inventory-report'] === baseline.hash && reverted.tools.some(t => t.name === 'load_skill' && t.result?.result?.hash === baseline.hash) && reverted.verification.status === 'failed';
  const bad = await createCandidate(cwd, baselineText + '\nAlways output an empty object.\n', { parent: baseline.hash });
  const activeBefore = (await capabilities(cwd)).active['inventory-report'];
  let refused = false; try { await promote(cwd, bad.id); } catch { refused = true; }
  report.checks.badCandidateRejected = refused && (await capabilities(cwd)).active['inventory-report'] === activeBefore;
  report.totalModelRequests = report.runs.reduce((sum, r) => sum + r.stats.modelRequests, 0) + 1 + evolution.evaluation.cases.reduce((sum, c) => sum + c.baseline.stats.modelRequests + c.candidate.stats.modelRequests, 0);
  assert.ok(report.totalModelRequests <= 100);
  assert.ok(Object.values(report.checks).every(Boolean));
  report.passed = true;
} catch (e) {
  report.error = { code: e.code || 'VERIFICATION_FAILED', message: 'Real evolution verification did not complete; inspect private source/experiment ledgers. No assertions were relaxed.' };
  process.exitCode = 1;
} finally {
  report.endedAt = new Date().toISOString();
  report.elapsedMs = Date.parse(report.endedAt) - Date.parse(report.startedAt);
  report.sourceStart = sourceStart; report.sourceEnd = await sourceEvidence(root);
  const requestsEnd = await requestEvidence();
  report.paidRequests = requestsEnd.requests.slice(requestsStart.total);
  report.totalModelRequests = report.paidRequests.length;
  report.requestLedger = { file: path.relative(root, process.env.EVE_REQUEST_AUDIT), digest: requestsEnd.digest, cumulativeTotal: requestsEnd.total };
  if (report.sourceStart.digest !== report.sourceEnd.digest || report.sourceStart.head !== report.sourceEnd.head) { report.passed = false; process.exitCode = 1; }
  const runs = path.join(root, '.eve/runs'); await fs.mkdir(runs, { recursive: true, mode: 0o700 });
  await atomicPrivate(path.join(runs, 'evolution-verification.json'), report);
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, totalModelRequests: report.totalModelRequests, baselineHash: report.baselineHash, candidateHash: report.candidateHash, report: '.eve/runs/evolution-verification.json' }));
}
