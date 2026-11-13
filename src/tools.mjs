import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSkill } from './skills.mjs';

const tool = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const str = description => ({ type: 'string', description });
export const TOOL_SCHEMAS = [
  tool('list_files', 'List files in a workspace directory. No recursion. Paths are workspace-relative.', { path: str('Directory, default .') }),
  tool('read_file', 'Read a UTF-8 file inside the workspace. Protected config paths and symlinks are blocked.', { path: str('Relative file path') }, ['path']),
  tool('write_file', 'Create or replace a UTF-8 workspace file. Does not execute code. Max 64 KiB. Only write when the user task authorizes it.', { path: str('Relative file path'), content: str('Full new file contents') }, ['path', 'content']),
  tool('load_skill', 'Load the full instructions of a discovered skill by name. Call before doing a matching task.', { name: str('Exact skill name from the available skills catalog') }, ['name']),
];
const SPECS = Object.fromEntries(TOOL_SCHEMAS.map(s => [s.function.name, s.function.parameters]));
export function parseArguments(name, json) {
  const spec = SPECS[name];
  if (!spec) throw new Error('未知工具');
  let args;
  try { args = JSON.parse(json || '{}'); } catch { throw new Error('工具参数必须是合法 JSON'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
  for (const key of Object.keys(args)) if (!(key in spec.properties)) throw new Error(`不允许的参数：${key}`);
  for (const key of spec.required) if (!(key in args)) throw new Error(`缺少参数：${key}`);
  for (const [key, value] of Object.entries(args)) if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`);
  return args;
}
function checkParts(relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || relative.includes('\\')) throw new Error('只允许 workspace 相对路径');
  const parts = relative.split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) throw new Error('禁止路径穿越');
  if (parts.some(p => ['.git', '.eve', '.ssh', '.aws', '.config'].includes(p) || p === '.env' || p.startsWith('.env.') || p.endsWith('.local.json'))) throw new Error('禁止访问受保护配置路径');
  return parts;
}
export async function safePath(root, relative, { createParents = false } = {}) {
  const parts = checkParts(relative);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) throw new Error('禁止跟随符号链接');
      if (i < parts.length - 1 && !st.isDirectory()) throw new Error('父路径不是目录');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (i < parts.length - 1) {
        if (!createParents) throw e;
        await fs.mkdir(current);
      }
    }
  }
  return current;
}
export async function createTools(cwd, discovered, config) {
  const root = await fs.realpath(cwd);
  return async (name, json, signal) => {
    signal?.throwIfAborted();
    const args = parseArguments(name, json);
    // Reject invalid writes before safePath is allowed to create parent directories.
    if (name === 'write_file' && Buffer.byteLength(args.content) > 65536) throw new Error('写入超过 64 KiB');
    if (name === 'load_skill') {
      const s = discovered.skills.get(args.name);
      if (!s) throw new Error('未发现该技能');
      if (path.resolve(s.file).split(path.sep).includes('.eve')) throw new Error('禁止访问受保护配置路径');
      return await loadSkill(s);
    }
    const target = await safePath(root, args.path ?? '.', { createParents: name === 'write_file' });
    signal?.throwIfAborted();
    if (name === 'list_files') {
      const entries = await fs.readdir(target, { withFileTypes: true });
      const visible = entries.filter(e => { try { checkParts(e.name); return !e.isSymbolicLink(); } catch { return false; } });
      visible.sort((a,b) => a.name.localeCompare(b.name));
      return { entries: visible.slice(0, 200).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })), truncated: visible.length > 200 };
    }
    if (name === 'read_file') {
      const st = await fs.stat(target);
      if (!st.isFile() || st.size > 262144) throw new Error('只能读取不超过 256 KiB 的普通文件');
      const text = await fs.readFile(target, { encoding: 'utf8', signal });
      return { path: args.path, content: text.slice(0, config.maxToolChars), truncated: text.length > config.maxToolChars };
    }
    if (name === 'write_file') {
      if (!args.path || target === root) throw new Error('写入需要文件路径');
      if (Buffer.byteLength(args.content) > 65536) throw new Error('写入超过 64 KiB');
      await fs.writeFile(target, args.content, { encoding: 'utf8', signal });
      return { path: args.path, bytes: Buffer.byteLength(args.content), written: true };
    }
    throw new Error('未知工具');
  };
}
