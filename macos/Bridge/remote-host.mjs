import fs from 'node:fs/promises';
import { RemoteConnector, remoteStatus } from '../../src/remote.mjs';
import { RemoteStore, inviteURI } from '../../src/remote-store.mjs';

export const remoteFields = Object.freeze({
 'remote.status': Object.freeze([]),
 'remote.configure': Object.freeze(['values']),
 'remote.start': Object.freeze([]),
 'remote.stop': Object.freeze([]),
 'remote.invite': Object.freeze([]),
 'remote.revoke': Object.freeze(['pairId'])
});
const settingKeys = ['enabled', 'relayUrl', 'desktopName', 'development', 'allowWrite', 'allowCompact', 'registrationKey', 'contracts'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const failure = (code, message) => Object.assign(new Error(message), { code });
function classified(error) {
 if (error?.code?.startsWith('REMOTE_')) return error;
 if (/Remote (writer already running|lock busy)/.test(error?.message ?? '')) return failure('REMOTE_WRITER_BUSY', '此工作区已有远程 writer（可能是 CLI）；请先停止它。');
 return failure('REMOTE_OPERATION', '远程操作失败；请检查本地设置、TLS 地址与文件权限后重试。');
}
// Explicit projection, including nested runtime records. Never return the private store.
function projection(value) {
 const settings = pick(value.settings, settingKeys.filter(k => k !== 'registrationKey'));
 settings.registrationConfigured = value.settings?.registrationConfigured === true;
 return {
  settings,
  pairs: (value.pairs ?? []).map(p => pick(p, ['pairId', 'createdAt', 'expiresAt', 'clientId', 'clientName', 'revoked', 'bound'])),
  runtime: {
   ...pick(value.runtime, ['enabled', 'pid', 'startedAt', 'updatedAt', 'busy']),
   connections: (value.runtime?.connections ?? []).map(c => pick(c, ['pairId', 'state', 'lastHealthy', 'authenticated']))
  }
 };
}

// Core stop drains task execution but an interval refresh may still be awaiting
// disk I/O. Drain those refreshes before stop publishes its final runtime and
// releases the writer lease, so an old workspace cannot publish after switching.
function trackRefreshes(connector) {
 const refresh = connector.refresh.bind(connector), stop = connector.stop.bind(connector);
 const pending = new Set();
 let stopping;
 connector.refresh = (...args) => {
  if (stopping) return Promise.resolve();
  const task = Promise.resolve().then(() => refresh(...args));
  pending.add(task);
  task.then(() => pending.delete(task), () => pending.delete(task));
  return task;
 };
 connector.stop = () => {
  if (!stopping) stopping = (async () => {
   await Promise.allSettled([...pending]);
   await stop();
  })();
  return stopping;
 };
 return connector;
}

/**
 * Host integration: dispatch these ops outside the local-task busy flag. Before
 * admitting local core work, check isRemoteBusy(). Await beforeWorkspaceSwitch()
 * before changing getWorkspace(), and await shutdown() on EOF.
 * Test factory signature: createConnector(cwd, {store, localBusy}); the supplied
 * store uses this adapter's writer lease. No HTTP server is created here.
 */
export function createRemoteOperations({
 getWorkspace, isLocalBusy = () => false,
 storeFactory = cwd => RemoteStore.open(cwd),
 createConnector = (_cwd, options) => new RemoteConnector(options.store, { localBusy: options.localBusy })
}) {
 let workspace = null, storePromise = null, connector = null, releaseWriter = null;
 let mutation = null, mutating = false, transition = null, closed = false;
 async function store() {
  const selected = getWorkspace();
  if (typeof selected !== 'string' || !selected.trim()) throw failure('REMOTE_NO_WORKSPACE', '请先选择工作区。');
  const root = await fs.realpath(selected);
  if (workspace && root !== workspace) throw failure('REMOTE_WORKSPACE_CHANGED', '切换工作区前必须等待 beforeWorkspaceSwitch()。');
  if (!storePromise) { workspace = root; storePromise = Promise.resolve().then(() => storeFactory(root)); }
  try { return await storePromise; }
  catch (error) { storePromise = null; throw error; }
 }
 const remoteActive = () => !!(connector?.service?.active || connector?.service?.running?.size || connector?.status?.().busy);
 async function status(s) {
  const result = await remoteStatus(s);
  if (connector) result.runtime = connector.status();
  return projection(result);
 }
 async function release() {
  if (releaseWriter) { const unlock = releaseWriter; await unlock(); releaseWriter = null; }
 }
 async function settleConnector() {
  // Keep the lease on stop failure: never admit a second writer mid-cleanup.
  if (connector) { await connector.stop(); connector = null; }
  await release();
 }
 async function mutate(op, params) {
  const s = await store();
  if (isLocalBusy()) throw failure('REMOTE_LOCAL_BUSY', '本地任务正在运行，请等待收尾。');
  if (remoteActive() && !['remote.stop', 'remote.revoke'].includes(op)) throw failure('REMOTE_BUSY', '远程任务正在运行，请先停止或等待收尾。');
  if (!releaseWriter) releaseWriter = await s.lock('connector.lock');
  try {
   switch (op) {
    case 'remote.configure':
     await s.configure(params.values);
     if (params.values.enabled === false) await settleConnector();
     else if (connector) await connector.refresh();
     break;
    case 'remote.start': {
     if (connector?.enabled) break;
     if (connector) await settleConnector();
     if (!releaseWriter) releaseWriter = await s.lock('connector.lock');
     // RemoteConnector also takes connector.lock. Delegate only that lock to
     // our already-held lease; state.lock remains the real store transaction.
     const leasedStore = new Proxy(s, { get(target, key) {
      if (key === 'lock') return name => name === 'connector.lock' ? Promise.resolve(async () => {}) : target.lock(name);
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
     } });
     await s.configure({ enabled: true });
     connector = trackRefreshes(await createConnector(workspace, { store: leasedStore, localBusy: () => mutating || !!transition || closed || isLocalBusy() }));
     try { await connector.start(); }
     catch (error) { await settleConnector(); throw error; }
     break;
    }
    case 'remote.stop':
     await s.configure({ enabled: false });
     await settleConnector();
     break;
    case 'remote.invite': {
     if (!(await s.settings()).relayUrl) throw failure('REMOTE_SETTINGS', '请先保存中继地址。');
     if (connector) return pick(await connector.invite(), ['uri', 'expiresAt', 'pairId']);
     const pair = await s.invite();
     return { uri: inviteURI(pair), expiresAt: pair.expiresAt, pairId: pair.pairId };
    }
    case 'remote.revoke':
     if (connector) await connector.revoke(params.pairId);
     else await s.revoke(params.pairId);
     break;
   }
   return await status(s);
  } finally {
   if (!connector) await release();
  }
 }
 function validate(op, params) {
  if (!Object.hasOwn(remoteFields, op) || !record(params) || Object.keys(params).some(k => !remoteFields[op].includes(k))) throw failure('REMOTE_ARGUMENT', '未知远程操作或参数。');
  if (op === 'remote.configure' && (!record(params.values) || Object.keys(params.values).some(k => !settingKeys.includes(k)))) throw failure('REMOTE_ARGUMENT', '远程设置只接受明确允许的字段。');
  if (op === 'remote.revoke' && (typeof params.pairId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(params.pairId))) throw failure('REMOTE_ARGUMENT', 'pairId 无效。');
 }
 async function call(op, params = {}) {
  try {
   validate(op, params);
   if (closed || transition) throw failure('REMOTE_CLOSING', '远程连接正在收尾。');
   if (op === 'remote.status') return await status(await store());
   if (mutating || isLocalBusy()) throw failure('REMOTE_LOCAL_BUSY', '本地或远程管理操作正在运行，请等待收尾。');
   mutating = true;
   mutation = mutate(op, params);
   try { return await mutation; } finally { mutation = null; mutating = false; }
  } catch (error) { throw classified(error); }
 }
 function cleanup(final) {
  if (final) closed = true;
  if (transition) return transition;
  transition = (async () => {
   try { await mutation; } catch { /* still stop after a failed management op */ }
   await settleConnector();
   workspace = null; storePromise = null;
  })().finally(() => { transition = null; });
  return transition;
 }
 return {
  call,
  beforeWorkspaceSwitch: () => cleanup(false),
  shutdown: () => cleanup(true),
  isRemoteBusy: () => mutating || !!transition || remoteActive()
 };
}
