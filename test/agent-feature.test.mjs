import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTools, parseArguments } from '../src/tools.mjs';
import { validateConfig } from '../src/config.mjs';
const cfg = x => validateConfig({ userSkills: false, ...x });
async function workspace(t) { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-agent-')); t.after(() => fs.rm(cwd, { recursive: true, force: true })); return cwd; }
test('search/edit: literal recursive filtering and unique exact multiline replacement', async t => {
 const cwd = await workspace(t); const exec = await createTools(cwd, { skills: new Map() }, cfg());
 await fs.mkdir(path.join(cwd, 'nested')); await fs.writeFile(path.join(cwd, 'nested/a.txt'), 'a.*\nold\ntext\nend');
 const search = await exec('search_files', JSON.stringify({ query: 'a.*', path_filter: '.txt' }));
 assert.equal(search.matches.length, 1); assert.equal(search.matches[0].path, 'nested/a.txt');
 const edited = await exec('edit_file', JSON.stringify({ path: 'nested/a.txt', old_text: 'old\ntext', new_text: 'new' }));
 assert.equal(edited.written, true); assert.equal(await fs.readFile(path.join(cwd, 'nested/a.txt'), 'utf8'), 'a.*\nnew\nend');
});
test('edit: zero/multiple/overlapping matches and unsafe paths have no side effects', async t => {
 const cwd = await workspace(t); const exec = await createTools(cwd, { skills: new Map() }, cfg());
 await fs.writeFile(path.join(cwd, 'a'), 'aaa');
 for (const old_text of ['absent', 'aa', '']) await assert.rejects(exec('edit_file', JSON.stringify({ path: 'a', old_text, new_text: 'x' })));
 assert.equal(await fs.readFile(path.join(cwd, 'a'), 'utf8'), 'aaa');
 for (const p of ['../x', '.eve/x', 'skills/a', 'x/SKILL.md', 'missing/a']) await assert.rejects(exec('edit_file', JSON.stringify({ path: p, old_text: 'a', new_text: 'b' })));
 await assert.rejects(fs.stat(path.join(cwd, 'missing')), { code: 'ENOENT' });
 await fs.symlink(path.join(cwd, 'a'), path.join(cwd, 'link'));
 await assert.rejects(exec('edit_file', JSON.stringify({ path: 'link', old_text: 'aaa', new_text: 'b' })));
});
test('search: bounded results, excluded config/dependencies/symlinks, safe root and strict types', async t => {
 const cwd = await workspace(t); const exec = await createTools(cwd, { skills: new Map() }, cfg());
 for (const d of ['.eve', '.git', 'node_modules']) { await fs.mkdir(path.join(cwd, d)); await fs.writeFile(path.join(cwd, d, 'secret'), 'needle'); }
 await fs.writeFile(path.join(cwd, 'a'), 'needle\n'.repeat(300)); await fs.symlink(path.join(cwd, '.eve'), path.join(cwd, 'link'));
 const r = await exec('search_files', JSON.stringify({ query: 'needle' })); assert(r.truncated); assert(r.matches.length <= 100); assert(r.matches.every(m => m.path === 'a'));
 for (const p of ['../', '.eve', 'link', 'node_modules']) await assert.rejects(exec('search_files', JSON.stringify({ query: 'needle', path: p })));
 assert.throws(() => parseArguments('search_files', '{"query":3}'));
 await assert.rejects(exec('search_files', '{"query":"x","regex":true}'));
});

test('edit: successful edit participates in independent write_readback acceptance', async t => {
 const { runSession } = await import('../src/sessions.mjs');
 const cwd = await workspace(t); await fs.writeFile(path.join(cwd, 'a'), 'before'); let n = 0;
 const r = await runSession({ cwd, config: cfg(), prompt: 'edit and read', contract: { version: 1, assertions: [{ type: 'write_readback', path: 'a' }, { type: 'text_equals', path: 'a', text: 'after' }] }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: n++ === 0 ? 'tool_calls' : 'stop', message: n === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'edit', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'a', old_text: 'before', new_text: 'after' }) } }] } : { role: 'assistant', content: 'done' } }] })) });
 assert.equal(r.status, 'completed'); assert.equal(r.verification.status, 'passed');
});

test('search: literal multiline query crosses lines', async t => {
 const cwd = await workspace(t); await fs.writeFile(path.join(cwd, 'a'), 'first\nsecond\nthird');
 const exec = await createTools(cwd, { skills: new Map() }, cfg());
 const r = await exec('search_files', JSON.stringify({ query: 'first\nsecond' })); assert.equal(r.matches[0]?.line, 1);
});
