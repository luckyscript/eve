import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { loadSession } from '../src/sessions.mjs';

const root = path.resolve(import.meta.dirname, '..');
const config = await loadConfig({ cwd: root });
const cwd = path.join(root, '.eve', `verify-sessions-${randomUUID()}`);
await fs.mkdir(path.join(cwd, '.eve'), { recursive: true, mode: 0o700 });
await fs.chmod(cwd, 0o700);
await fs.writeFile(path.join(cwd, '.eve/config.local.json'), JSON.stringify({ ...config, userSkills: false, skillsDirs: [] }), { mode: 0o600 });
const nonce = randomUUID();
const contract = file => ({ version: 1, assertions: [
  { type: 'json_equals', path: file, field: ['nonce'], value: nonce },
  { type: 'write_readback', path: file },
] });
await fs.writeFile(path.join(cwd, 'first-contract.json'), JSON.stringify(contract('first.json')));
await fs.writeFile(path.join(cwd, 'next-contract.json'), JSON.stringify(contract('next.json')));
await fs.writeFile(path.join(cwd, 'wrong.json'), '{"answer":0}');
await fs.writeFile(path.join(cwd, 'wrong-contract.json'), JSON.stringify({ version: 1, assertions: [{ type: 'json_equals', path: 'wrong.json', field: ['answer'], value: 42 }] }));
async function run(sessionId, file, prompt) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'bin/eve.mjs'), 'run', '--cwd', cwd, '--session', sessionId, '--contract', file, '--prompt', prompt, '--json']);
    let stdout = '';
    child.stdout.on('data', b => stdout += b);
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), config.timeoutMs + 15000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      try { resolve({ code, result: JSON.parse(stdout) }); } catch { reject(new Error('Live CLI produced no structured result')); }
    });
  });
}
const report = { at: new Date().toISOString(), workspace: path.relative(root, cwd), passed: false, checks: {}, runs: [] };
try {
  console.log('live: creating artifact and persisting session');
  const first = await run('live-continue', 'first-contract.json', `请创建 first.json，内容为 JSON 对象 {"nonce":"${nonce}"}，写后读取验证。记住 nonce 以便后续会话使用。`);
  report.runs.push({ code: first.code, status: first.result.status, modelStatus: first.result.modelStatus, verification: first.result.verification?.status, stats: first.result.stats });
  report.checks.firstAccepted = first.code === 0 && first.result.verification.status === 'passed';
  assert(report.checks.firstAccepted, 'first artifact not accepted (service may be unavailable; inspect local ledger)');
  console.log('live: continuing in a separate CLI process');
  const next = await run('live-continue', 'next-contract.json', '请用前一轮记住的完全相同 nonce 创建 next.json，内容为 {"nonce":前一轮的nonce字符串}。写后读取核验，不要使用新 nonce。');
  report.runs.push({ code: next.code, status: next.result.status, modelStatus: next.result.modelStatus, verification: next.result.verification?.status, stats: next.result.stats });
  report.checks.continuationAccepted = next.code === 0 && next.result.verification.status === 'passed';
  assert(report.checks.continuationAccepted, 'continued artifact not accepted');
  console.log('live: rejecting a preexisting incorrect artifact despite model completion');
  const wrong = await run('live-rejected', 'wrong-contract.json', '这是一个只需回答的会话测试：不要调用任何工具，也不要修改任何文件。请只回答“已完成”。');
  report.runs.push({ code: wrong.code, status: wrong.result.status, modelStatus: wrong.result.modelStatus, verification: wrong.result.verification?.status, stats: wrong.result.stats });
  report.checks.wrongArtifactRejected = wrong.code === 1 && wrong.result.modelStatus === 'completed' && wrong.result.status === 'failed' && wrong.result.verification.status === 'failed';
  assert(report.checks.wrongArtifactRejected, 'incorrect artifact was not independently rejected');
  const ledger = await loadSession(cwd, 'live-continue');
  report.checks.historyPersisted = ledger.runs.length === 2 && ledger.runs[1].messages.length > ledger.runs[0].messages.length;
  report.checks.readAfterWrite = ledger.runs.every(r => {
    const write = r.tools.findIndex(x => x.name === 'write_file' && x.status === 'completed');
    return write >= 0 && r.tools.slice(write + 1).some(x => x.name === 'read_file' && x.status === 'completed');
  });
  assert(report.checks.historyPersisted && report.checks.readAfterWrite, 'missing durable history or model readback');
  report.passed = true;
} catch (e) {
  report.error = e.code === 'ECONNREFUSED' ? 'model_service_unavailable' : 'live_verification_failed';
  process.exitCode = 1;
} finally {
  // Keep private ignored ledgers for failure evidence; remove the copied authentication file.
  await fs.rm(path.join(cwd, '.eve/config.local.json'), { force: true });
  await fs.mkdir(path.join(root, '.eve/runs'), { recursive: true });
  await fs.writeFile(path.join(root, '.eve/runs/session-verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
