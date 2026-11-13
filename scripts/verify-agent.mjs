import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { loadSession } from '../src/sessions.mjs';

const root = path.resolve(import.meta.dirname, '..');
const config = await loadConfig({ cwd: root });
const timeoutMs = 240000;
const cwd = path.join(root, '.eve', `verify-agent-${randomUUID()}`);
await fs.mkdir(path.join(cwd, '.eve/contracts'), { recursive: true, mode: 0o700 });
await fs.chmod(cwd, 0o700);
const settings = { ...config, userSkills: false, skillsDirs: [], timeoutMs, maxSteps: 8, maxToolCalls: 12, maxOutputTokens: 1024, maxToolChars: 16000, contextMaxChars: 30000, contextRecentGroups: 1, contextSummaryChars: 2000 };
const saveSettings = () => fs.writeFile(path.join(cwd, '.eve/config.local.json'), JSON.stringify(settings), { mode: 0o600 });
await saveSettings();
const fact = `cedar-${randomUUID()}`;
const marker = `probe-${randomUUID()}`;
await fs.mkdir(path.join(cwd, 'nested'));
await fs.writeFile(path.join(cwd, 'nested/target.txt'), `marker=${marker}\nmode=old\n`);
await fs.writeFile(path.join(cwd, 'tail.txt'), 'Trace inspection finished.');
await fs.writeFile(path.join(cwd, 'memory.txt'), `The previously assigned archive code is ${fact}.\n`);
await fs.writeFile(path.join(cwd, 'bulk.txt'), Array.from({ length: 270 }, (_, i) => `Trace item ${i}: routine local workspace observation, no new facts.\n`).join(''));
await fs.writeFile(path.join(cwd, '.eve/contracts/edit.json'), JSON.stringify({ version: 1, assertions: [{ type: 'text_equals', path: 'nested/target.txt', text: `marker=${marker}\nmode=new\n` }, { type: 'write_readback', path: 'nested/target.txt' }] }));
await fs.writeFile(path.join(cwd, '.eve/contracts/recall.json'), JSON.stringify({ version: 1, assertions: [{ type: 'json_equals', path: 'recall.json', field: ['code'], value: fact }, { type: 'write_readback', path: 'recall.json' }] }));
async function cli(args) {
 return await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'bin/eve.mjs'), ...args, '--cwd', cwd, '--json']);
  let stdout = ''; child.stdout.on('data', b => stdout += b); child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 15000);
  child.once('error', reject);
  child.once('close', code => { clearTimeout(timer); try { resolve({ code, result: JSON.parse(stdout) }); } catch { reject(new Error('live_cli_no_result')); } });
 });
}
const report = { at: new Date().toISOString(), workspace: path.relative(root, cwd), timeoutMsPerTask: timeoutMs, ceilings: { requestsPerTask: 8, outputTokensPerRequest: 1024, summaryRequestsPerTask: 1 }, passed: false, checks: {}, runs: [] };
function record(label, r) { report.runs.push({ label, exitCode: r.code, status: r.result.status, verification: r.result.verification?.status, stats: r.result.stats, context: r.result.context, errorCode: r.result.error?.code }); assert.equal(r.code, 0, `${label}_failed`); }
try {
 console.log('live: search → exact edit → model readback → independent contract');
 const edit = await cli(['run', '--session', 'edit', '--contract', '.eve/contracts/edit.json', '--prompt', `Find the file containing literal marker ${marker} using search_files. Then use edit_file to replace the unique exact text mode=old with mode=new. Read the edited file with read_file before finishing.`]); record('search-edit-readback', edit);
 const edited = await loadSession(cwd, 'edit');
 const names = edited.runs[0].tools.filter(t => t.status === 'completed').map(t => t.name);
 assert(names.indexOf('search_files') >= 0 && names.indexOf('edit_file') > names.indexOf('search_files') && names.lastIndexOf('read_file') > names.indexOf('edit_file'));
 report.checks.searchEditReadbackAccepted = edit.result.verification.status === 'passed';
 console.log('live: remember a random fact read from a file (answer absent from user prompts)');
 const remember = await cli(['run', '--session', 'memory', '--prompt', 'Read memory.txt and remember its assigned archive code for a later task. Reply only “remembered”, do not repeat the code or write any files.']); record('remember', remember);
 console.log('live: add real tool history larger than the next request budget');
 const bulk = await cli(['run', '--session', 'memory', '--prompt', 'Read bulk.txt once to inspect the trace. Reply only “trace reviewed”; do not repeat its contents or previous facts and do not write files.']); record('bulk-history', bulk);
 const tail = await cli(['run', '--session', 'memory', '--prompt', 'Read tail.txt once and reply only “finished”. Do not repeat previous facts.']); record('recent-small-tool-group', tail);
 const before = await loadSession(cwd, 'memory');
 const originalHash = createHash('sha256').update(JSON.stringify(before.runs)).digest('hex');
 assert(before.runs.some(r => r.tools.some(t => t.name === 'read_file' && t.arguments.path === 'memory.txt' && t.result?.result?.content.includes(fact))));
 assert(before.runs.some(r => r.tools.some(t => t.name === 'read_file' && t.arguments.path === 'bulk.txt' && t.result?.result?.content.length >= 14000)));
 await fs.rm(path.join(cwd, 'memory.txt')); await fs.rm(path.join(cwd, 'bulk.txt'));
 settings.contextMaxChars = 12000; await saveSettings();
 console.log('live: compress in a separate process, preserving raw evidence');
 const compact = await cli(['compact', '--session', 'memory']); record('compact', compact);
 const compressed = await loadSession(cwd, 'memory');
 assert.equal(createHash('sha256').update(JSON.stringify(compressed.runs)).digest('hex'), originalHash);
 assert.equal(compressed.context.summary.method, 'model', 'live requires successful model summary, not fallback');
 assert(compressed.context.summary.modelSummary.includes(fact), 'fact must be carried by model summary');
 assert(!JSON.stringify(compressed.context.view).includes(fact), 'fact must leave retained recent messages');
 assert(!JSON.stringify(compressed.context.summary.users).includes(fact), 'user prompt cannot leak the fact');
 assert(compressed.contextEvents.some(e => e.type === 'context_summary' && e.sourceCount > 0));
 report.checks.rawLogsPreserved = true; report.checks.modelSummaryCarriesFileFact = true;
 report.summaryEvidence = { method: compressed.context.summary.method, sourceCount: compressed.context.summary.sources.length, sourceDigest: compressed.context.summary.sourceDigest, rawHistoryChars: JSON.stringify(before.runs.at(-1).messages).length, compactChars: compressed.context.chars, maxChars: settings.contextMaxChars };
 console.log('live: continue in another process, without the original file or answer in the prompt');
 const recall = await cli(['run', '--session', 'memory', '--contract', '.eve/contracts/recall.json', '--prompt', 'Using only the remembered archive code from earlier context, create recall.json as {"code":"the exact earlier code"}, then read it back. The original memory file is unavailable; do not invent a new code.']); record('recall-after-compact', recall);
 assert.equal(recall.result.verification.status, 'passed');
 const after = await loadSession(cwd, 'memory');
 assert(after.runs.every(r => !r.prompt.includes(fact)));
 assert(!after.runs.at(-1).systemMessage.content.includes(fact), 'contract expected must remain hidden');
 assert.equal(remember.result.stats.summaryRequests, 0);
 report.checks.crossProcessRecallAccepted = true; report.checks.smallTaskNoSummary = true; report.checks.expectedAbsentFromPrompts = true;
 report.checks.boundedRequests = report.runs.every(r => r.stats.modelRequests <= 8 && r.stats.summaryRequests <= 1);
 assert(report.checks.boundedRequests);
 report.passed = true;
} catch (e) { report.error = e instanceof assert.AssertionError ? e.message.split('\n')[0] : 'live_verification_failed'; process.exitCode = 1; }
finally {
 await fs.rm(path.join(cwd, '.eve/config.local.json'), { force: true });
 await fs.mkdir(path.join(root, '.eve/runs'), { recursive: true });
 await fs.writeFile(path.join(root, '.eve/runs/agent-verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
 console.log(JSON.stringify(report, null, 2));
}
