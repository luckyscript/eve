import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { loadSkill } from './skills.mjs';

const tool = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const str = description => ({ type: 'string', description });
export const TOOL_SCHEMAS = [
  tool('list_files', 'List files in a workspace directory. No recursion. Paths are workspace-relative.', { path: str('Directory, default .') }),
  tool('read_file', 'Read a UTF-8 file inside the workspace. Protected config paths and symlinks are blocked.', { path: str('Relative file path') }, ['path']),
  tool('write_file', 'Create or replace a UTF-8 workspace file. Does not execute code. Max 64 KiB. Only write when the user task authorizes it.', { path: str('Relative file path'), content: str('Full new file contents') }, ['path', 'content']),
  tool('search_files', 'Recursively search UTF-8 workspace text using literal query (no regex). Max 500 files, 2 MiB scanned, 100 matches. Excludes protected paths and node_modules. path_filter is a literal path substring.', { query: str('Nonempty literal text, max 1024 chars'), path: str('Search root directory, default .'), path_filter: str('Optional literal relative-path substring') }, ['query']),
  tool('edit_file', 'Replace exactly one occurrence of old_text with new_text in an existing UTF-8 file. Zero or multiple (including overlapping) matches fail without writing. Max 64 KiB.', { path: str('Relative file path'), old_text: str('Nonempty exact text'), new_text: str('Replacement text') }, ['path', 'old_text', 'new_text']),
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
        await fs.mkdir(current, { mode: 0o700 });
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
      if (!s) throw new Error('未发现该技能；未发布候选或受保护配置路径不可加载');
      if (!s.published && path.relative(root, s.file).split(path.sep).includes('.eve')) throw new Error('禁止访问受保护配置路径');
      return await loadSkill(s);
    }
    if (name === 'write_file' || name === 'edit_file') {
      checkParts(args.path);
      const target = path.resolve(root, args.path);
      const roots = (config.skillsDirs || []).map(d => path.resolve(root, d.replace(/^~(?=\/)/, os.homedir())));
      for (const s of discovered.skills.values()) if (s.root) roots.push(s.root);
      if (path.basename(target) === 'SKILL.md' || roots.some(dir => target === dir || target.startsWith(dir + path.sep))) throw new Error('禁止直接写入技能路径；请由用户维护或经过独立评测发布');
    }
    const target = await safePath(root, args.path ?? '.', { createParents: name === 'write_file' });
    signal?.throwIfAborted();
    if (name === 'list_files') {
      const entries = await fs.readdir(target, { withFileTypes: true });
      const visible = entries.filter(e => { try { checkParts(e.name); return !e.isSymbolicLink(); } catch { return false; } });
      visible.sort((a,b) => a.name.localeCompare(b.name));
      return { entries: visible.slice(0, 200).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })), truncated: visible.length > 200 };
    }
    if (name === 'search_files') {
      if (!args.query || args.query.length > 1024 || (args.path_filter?.length || 0) > 1024) throw new Error('搜索词需要 1–1024 字符，路径过滤最多 1024 字符');
      if ((args.path || '').split('/').includes('node_modules')) throw new Error('搜索排除 node_modules');
      const matches = []; let files = 0, bytes = 0, visited = 0, truncated = false;
      const maxResult = Math.min(config.maxToolChars, 16000);
      const walk = async relative => {
        const dir = await safePath(root, relative);
        const handle = await fs.opendir(dir);
        for await (const entry of handle) {
          signal?.throwIfAborted();
          if (++visited > 2000 || files >= 500 || bytes >= 2097152 || matches.length >= 100) { truncated = true; break; }
          const rel = path.posix.join(relative, entry.name);
          try { checkParts(rel); } catch { continue; }
          if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await walk(rel);
          else if (entry.isFile() && (!args.path_filter || rel.includes(args.path_filter))) {
            files++;
            const file = await safePath(root, rel); const st = await fs.lstat(file);
            if (!st.isFile() || st.size > 262144) continue;
            if (bytes + st.size > 2097152) { truncated = true; continue; }
            const buf = await fs.readFile(file, { signal }); bytes += buf.length;
            if (buf.includes(0)) continue;
            const text = new TextDecoder('utf-8', { fatal: true }); let content;
            try { content = text.decode(buf); } catch { continue; }
            let offset = 0;
            for (;;) {
              const index = content.indexOf(args.query, offset);
              if (index < 0) break;
              const lineStart = content.lastIndexOf('\n', index - 1) + 1;
              const match = { path: rel, line: content.slice(0, index).split('\n').length, text: content.slice(lineStart, Math.min(content.length, lineStart + 500)) };
              if (matches.length >= 100 || JSON.stringify([...matches, match]).length > maxResult) { truncated = true; break; }
              matches.push(match); offset = index + Math.max(1, args.query.length);
            }
          }
          if (truncated) break;
        }
      };
      await walk(args.path || '.');
      return { matches, filesScanned: files, bytesScanned: bytes, truncated, limits: { files: 500, bytes: 2097152, matches: 100, entries: 2000 } };
    }
    if (name === 'edit_file') {
      if (!args.old_text || Buffer.byteLength(args.old_text) > 65536 || Buffer.byteLength(args.new_text) > 65536) throw new Error('编辑需要非空 old_text，内容最多 64 KiB');
      const st = await fs.lstat(target);
      if (!st.isFile() || st.size > 65536) throw new Error('只能编辑不超过 64 KiB 的普通文件');
      const bytes = await fs.readFile(target, { signal });
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const first = content.indexOf(args.old_text);
      if (first < 0) throw new Error('精确编辑拒绝：0 个命中');
      if (content.indexOf(args.old_text, first + 1) >= 0) throw new Error('精确编辑拒绝：多个命中，必须唯一');
      const next = content.slice(0, first) + args.new_text + content.slice(first + args.old_text.length);
      if (Buffer.byteLength(next) > 65536) throw new Error('编辑结果超过 64 KiB');
      signal?.throwIfAborted();
      await fs.writeFile(target, next, { encoding: 'utf8', signal });
      return { path: args.path, bytes: Buffer.byteLength(next), written: true, sha256: createHash('sha256').update(next).digest('hex') };
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
      await fs.writeFile(target, args.content, { encoding: 'utf8', signal, mode: 0o600 });
      return { path: args.path, bytes: Buffer.byteLength(args.content), written: true };
    }
    throw new Error('未知工具');
  };
}
