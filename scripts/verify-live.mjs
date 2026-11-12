import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { loadConfig, redact } from '../src/config.mjs';
import { runAgent } from '../src/agent.mjs';

const project = path.resolve(import.meta.dirname, '..');
let workspace;
let config;
try {
  config = await loadConfig({ cwd: project });
  await fs.mkdir(path.join(project, '.eve'), { recursive: true });
  workspace = await fs.mkdtemp(path.join(project, '.eve', 'verify-live-'));
  const marker = 'EVE_PROOF_' + crypto.randomBytes(12).toString('hex');
  const items = ['alpha-' + crypto.randomBytes(4).toString('hex'), 'beta-' + crypto.randomBytes(4).toString('hex')];
  await fs.mkdir(path.join(workspace, 'skills', 'workspace-report'), { recursive: true });
  const baseSkill = await fs.readFile(path.join(project, 'skills', 'workspace-report', 'SKILL.md'), 'utf8');
  // Only the skill body carries the nonce; neither metadata nor user prompt reveals it.
  await fs.writeFile(path.join(workspace, 'skills', 'workspace-report', 'SKILL.md'), baseSkill + `\nVerification variant: add one extra field to report.json: proof = ${marker}. This exact value must be copied from these loaded skill instructions, never guessed.\n`);
  await fs.writeFile(path.join(workspace, 'inventory.txt'), items.join('\n') + '\n');
  const result = await runAgent({ cwd: workspace, config: { ...config, skillsDirs: ['skills'], userSkills: false }, prompt: '请使用适合的技能，根据 inventory.txt 生成工作区报告 report.json，完成后读回核验并简短说明。' });
  const events = result.events;
  const loaded = events.findIndex(e => e.type === 'tool_end' && e.name === 'load_skill' && e.ok);
  const read = events.findIndex(e => e.type === 'tool_end' && e.name === 'read_file' && e.ok);
  const write = events.findIndex(e => e.type === 'tool_end' && e.name === 'write_file' && e.ok);
  let report;
  try { report = JSON.parse(await fs.readFile(path.join(workspace, 'report.json'), 'utf8')); } catch { report = null; }
  const finalRead = events.findIndex((e, i) => i > write && e.type === 'tool_end' && e.name === 'read_file' && e.ok);
  // Check wire history: the skill body was returned as a tool message before a later model request.
  const injected = result.messages.some(m => m.role === 'tool' && m.content.includes(marker));
  const checks = {
    completed: result.status === 'completed',
    skillDiscovered: events.some(e => e.type === 'skills_discovered' && e.skills.includes('workspace-report')),
    skillLoadedBeforeTaskTools: loaded >= 0 && loaded < read && read < write,
    skillBodyInjected: injected,
    modelContinuedAfterTools: result.stats.modelRequests >= 2,
    sourceDataCorrect: JSON.stringify(report?.items) === JSON.stringify(items),
    skillOnlyNonceCorrect: report?.proof === marker,
    reportSchemaCorrect: report?.title === 'eve workspace report' && report?.source === 'inventory.txt' && report?.skill_version === 'workspace-report/1',
    readBackAfterWrite: finalRead > write,
  };
  const passed = Object.values(checks).every(Boolean);
  const proof = { timestamp: new Date().toISOString(), passed, checks, status: result.status, stats: result.stats, events, ...(result.error ? { error: result.error } : {}) };
  await fs.mkdir(path.join(project, '.eve', 'runs'), { recursive: true });
  await fs.writeFile(path.join(project, '.eve', 'runs', 'live-verification.json'), redact(JSON.stringify(proof, null, 2), config) + '\n', { mode: 0o600 });
  console.log(redact(JSON.stringify(proof, null, 2), config));
  assert(passed, '本地模型端到端验证未全部通过；见 .eve/runs/live-verification.json');
} catch (e) {
  console.error(redact(`验证失败：${e.message}`, config));
  process.exitCode = 1;
} finally {
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
}
