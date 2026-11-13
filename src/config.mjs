import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:3425/v1',
  model: 'macmini-magpie/bailian-token-plan/qwen3.8-max',
  apiKey: '', maxSteps: 12, maxToolCalls: 24, timeoutMs: 90000,
  maxOutputTokens: 4096, maxToolChars: 16000, temperature: 0,
  contextMaxChars: 100000, contextRecentGroups: 2, contextSummaryChars: 4000,
  skillsDirs: ['skills'], userSkills: true,
});
const ENV_FIELDS = {
  EVE_CONTEXT_MAX_CHARS: 'contextMaxChars',
  EVE_BASE_URL: 'baseUrl', EVE_MODEL: 'model', EVE_API_KEY: 'apiKey',
  EVE_MAX_STEPS: 'maxSteps', EVE_MAX_TOOL_CALLS: 'maxToolCalls',
  EVE_TIMEOUT_MS: 'timeoutMs', EVE_MAX_OUTPUT_TOKENS: 'maxOutputTokens',
};
const NUMBERS = new Set(['maxSteps', 'maxToolCalls', 'timeoutMs', 'maxOutputTokens', 'maxToolChars', 'temperature', 'contextMaxChars', 'contextRecentGroups', 'contextSummaryChars']);
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是 JSON 对象');
  for (const key of Object.keys(input)) if (!(key in DEFAULTS)) throw new Error(`未知配置项：${key}`);
  const c = { ...DEFAULTS, ...input };
  let url;
  try { url = new URL(c.baseUrl); } catch { throw new Error('baseUrl 必须是有效 HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('baseUrl 仅支持无凭据、无 query/hash 的 HTTP(S) URL');
  c.baseUrl = c.baseUrl.replace(/\/+$/, '');
  if (typeof c.model !== 'string' || !c.model.trim()) throw new Error('model 不能为空');
  if (typeof c.apiKey !== 'string') throw new Error('apiKey 必须是字符串');
  for (const key of NUMBERS) {
    if (!Number.isFinite(c[key]) || c[key] < (key === 'temperature' ? 0 : 1)) throw new Error(`${key} 数值无效`);
    if (key !== 'temperature' && !Number.isInteger(c[key])) throw new Error(`${key} 必须是整数`);
  }
  if (c.temperature > 2 || c.maxSteps > 100 || c.maxToolCalls > 200 || c.timeoutMs > 600000 || c.maxOutputTokens > 32768 || c.maxToolChars > 131072) throw new Error('配置超过 PoC 允许的预算范围');
  if (c.contextMaxChars < 4096 || c.contextMaxChars > 200000 || c.contextRecentGroups > 20 || c.contextSummaryChars > 16000) throw new Error('context 预算范围无效（maxChars 4096–200000，recentGroups 1–20，summaryChars 1–16000）');
  if (!Array.isArray(c.skillsDirs) || !c.skillsDirs.every(x => typeof x === 'string' && x.length > 0)) throw new Error('skillsDirs 必须是路径数组');
  if (typeof c.userSkills !== 'boolean') throw new Error('userSkills 必须是布尔值');
  return c;
}
async function readJson(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    try { const data = JSON.parse(text); validateConfig(data); return data; }
    catch { throw new Error(`配置文件格式或字段无效：${file}`); }
  } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
export async function loadConfig({ cwd = process.cwd(), env = process.env, overrides = {} } = {}) {
  const globalFile = path.join(os.homedir(), '.config', 'eve', 'config.json');
  const files = [globalFile, path.join(cwd, '.eve', 'config.json'), path.join(cwd, '.eve', 'config.local.json')];
  if (env.EVE_CONFIG) files.push(path.resolve(cwd, env.EVE_CONFIG));
  let merged = {};
  for (const file of files) merged = { ...merged, ...await readJson(file) };
  for (const [name, key] of Object.entries(ENV_FIELDS)) if (env[name] !== undefined) merged[key] = NUMBERS.has(key) ? Number(env[name]) : env[name];
  return validateConfig({ ...merged, ...overrides });
}
export function redactConfig(c) { return { ...c, apiKey: c.apiKey ? '[configured]' : '[not configured]' }; }
export function redact(text, c) {
  let value = String(text);
  // Never render terminal escape sequences supplied by a model, tool or server.
  value = value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (c?.apiKey) value = value.split(c.apiKey).join('[redacted]');
  return value;
}
export async function setLocalConfig(cwd, key, value) {
  if (!(key in DEFAULTS)) throw new Error(`未知配置项：${key}`);
  if (key === 'apiKey') throw new Error('密钥请用 EVE_API_KEY 或手动编辑忽略追踪的 .eve/config.local.json，避免 shell 历史泄露');
  let parsed = value;
  if (NUMBERS.has(key)) parsed = Number(value);
  if (key === 'userSkills' || key === 'skillsDirs') { try { parsed = JSON.parse(value); } catch { throw new Error('该字段需要 JSON 值'); } }
  const file = path.join(cwd, '.eve', 'config.local.json');
  const old = await readJson(file);
  validateConfig({ ...old, [key]: parsed });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...old, [key]: parsed }, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(file, 0o600);
}
