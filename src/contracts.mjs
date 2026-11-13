import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { safePath } from './tools.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = x => x && typeof x === 'object' && !Array.isArray(x);
export function validateContract(input) {
  if (!object(input) || input.version !== 1 || Object.keys(input).some(k => !['version', 'assertions'].includes(k)) || !Array.isArray(input.assertions) || !input.assertions.length || input.assertions.length > 100) throw new Error('验收契约需要 version:1 和 1–100 个 assertions');
  const fields = { file_exists: [], json_equals: ['field', 'value'], text_contains: ['text'], text_equals: ['text'], sha256_equals: ['sha256'], write_readback: [] };
  for (const a of input.assertions) {
    if (!object(a) || !Object.hasOwn(fields, a.type) || typeof a.path !== 'string' || !a.path || Object.keys(a).some(k => !['type', 'path', ...fields[a.type]].includes(k))) throw new Error('验收 assertion 类型或字段无效');
    if (a.type === 'json_equals' && (!Array.isArray(a.field) || !a.field.every(k => typeof k === 'string') || !Object.hasOwn(a, 'value'))) throw new Error('json_equals 需要字符串数组 field 和 JSON value');
    if (['text_contains', 'text_equals'].includes(a.type) && typeof a.text !== 'string') throw new Error('text assertion 需要 text');
    if (a.type === 'sha256_equals' && !/^[a-f0-9]{64}$/.test(a.sha256 || '')) throw new Error('sha256_equals 需要 SHA-256');
  }
  return structuredClone(input);
}
export async function loadContract(cwd, file) {
  // The CLI explicitly trusts the contract file location; assertion targets remain confined.
  const st = await fs.stat(path.resolve(cwd, file));
  if (!st.isFile() || st.size > 262144) throw new Error('契约必须是不超过 256 KiB 的 JSON 文件');
  let data;
  try { data = JSON.parse(await fs.readFile(path.resolve(cwd, file), 'utf8')); }
  catch { throw new Error('契约不是合法 JSON'); }
  const contract = validateContract(data);
  await contractTargets(cwd, contract);
  return contract;
}
async function contractTargets(cwd, contract) {
  const root = await fs.realpath(cwd);
  const targets = [];
  for (const a of contract.assertions) {
    try { targets.push(await safePath(root, a.path)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; targets.push(null); }
  }
  return targets;
}
export async function verifyContract(cwd, input, { tools = [] } = {}) {
  const contract = validateContract(input);
  const targets = await contractTargets(cwd, contract);
  const assertions = [];
  for (const [index, a] of contract.assertions.entries()) {
    const record = { index, type: a.type, path: a.path, passed: false };
    try {
      if (!targets[index]) throw new Error('artifact_missing');
      const st = await fs.stat(targets[index]);
      if (!st.isFile()) throw new Error('artifact_not_file');
      if (a.type === 'file_exists') record.passed = true;
      else {
        if (st.size > 262144) throw new Error('artifact_too_large');
        const bytes = await fs.readFile(targets[index]);
        record.sha256 = hash(bytes);
        const text = bytes.toString('utf8');
        if (a.type === 'text_contains') record.passed = text.includes(a.text);
        if (a.type === 'text_equals') record.passed = text === a.text;
        if (a.type === 'sha256_equals') record.passed = record.sha256 === a.sha256;
        if (a.type === 'json_equals') {
          let value = JSON.parse(text);
          for (const key of a.field) value = value != null && Object.hasOwn(Object(value), key) ? value[key] : undefined;
          record.passed = isDeepStrictEqual(value, a.value);
        }
        if (a.type === 'write_readback') {
          const write = tools.findLast(t => ['write_file', 'edit_file'].includes(t.name) && t.status === 'completed' && t.result?.ok && t.arguments?.path === a.path);
          record.passed = !!write && (write.name === 'edit_file' ? write.result.result.sha256 : hash(Buffer.from(write.arguments.content))) === record.sha256;
        }
      }
      if (!record.passed) record.reason = 'assertion_mismatch';
    } catch (e) {
      record.reason = e.code === 'ENOENT' ? 'artifact_missing' : e instanceof SyntaxError ? 'invalid_json' : ['artifact_missing', 'artifact_not_file', 'artifact_too_large'].includes(e.message) ? e.message : 'artifact_read_error';
    }
    assertions.push(record);
  }
  return { status: assertions.every(a => a.passed) ? 'passed' : 'failed', checkedAt: new Date().toISOString(), assertions };
}
