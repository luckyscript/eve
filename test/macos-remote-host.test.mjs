import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteOperations, remoteFields } from '../macos/Bridge/remote-host.mjs';
import { RemoteConnector } from '../src/remote.mjs';
import { RemoteStore } from '../src/remote-store.mjs';
import { atomicPrivate } from '../src/registry.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
 const base = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-native-remote-'));
 const first = path.join(base, 'first'), second = path.join(base, 'second');
 await fs.mkdir(first); await fs.mkdir(second);
 const state = { workspace: first, localBusy: false };
 const ops = createRemoteOperations({ getWorkspace: () => state.workspace, isLocalBusy: () => state.localBusy, ...options });
 t.after(async () => { await ops.shutdown(); await fs.rm(base, { recursive: true, force: true }); });
 return { ops, state, first, second };
}
const configure = ops => ops.call('remote.configure', { values: { relayUrl: 'https://relay.example.com', desktopName: 'Test Mac' } });
const code = value => error => error.code === value;

test('stable dispatch fields; strict settings and real store TLS / permission validation', async t => {
 assert.deepEqual(remoteFields, { 'remote.status': [], 'remote.configure': ['values'], 'remote.start': [], 'remote.stop': [], 'remote.invite': [], 'remote.revoke': ['pairId'] });
 const { ops, first } = await fixture(t);
 let status = await ops.call('remote.status');
 assert.equal(status.settings.allowWrite, false); assert.equal(status.settings.allowCompact, false);
 for (const params of [{}, { values: [] }, { values: { arbitrarySecret: 'private' } }, { values: { apiKey: 'private' } }, { values: {}, extra: true }]) {
  await assert.rejects(ops.call('remote.configure', params), code('REMOTE_ARGUMENT'));
 }
 for (const values of [{ allowWrite: 'true' }, { allowCompact: 1 }, { relayUrl: 'http://example.com', development: true }, { relayUrl: 'https://user:password@example.com' }, { relayUrl: 'https://relay.example.com/?key=credential' }, { contracts: { '../bad': '/tmp/file' } }, { registrationKey: { token: 'bad' } }]) {
  await assert.rejects(ops.call('remote.configure', { values }), code('REMOTE_OPERATION'));
 }
 await assert.rejects(ops.call('remote.status', { secret: true }), code('REMOTE_ARGUMENT'));
 await assert.rejects(ops.call('remote.revoke', { pairId: '../bad' }), code('REMOTE_ARGUMENT'));
 status = await ops.call('remote.configure', { values: { relayUrl: 'http://127.0.0.1:3333', development: true, contracts: { review: '/tmp/review.json' } } });
 assert.equal(status.settings.relayUrl, 'http://127.0.0.1:3333');
 assert.deepEqual(status.settings.contracts, { review: '/tmp/review.json' });
 assert.equal(status.settings.allowWrite, false); assert.equal(status.settings.allowCompact, false);
 const file = path.join(first, '.eve/remote/state.json');
 assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('invitation is explicit only, expires in ten minutes, status redacts credentials, offline revoke works', async t => {
 const { ops, first } = await fixture(t);
 await assert.rejects(ops.call('remote.invite'), code('REMOTE_SETTINGS'));
 await configure(ops);
 await ops.call('remote.configure', { values: { registrationKey: 'registration-credential-for-test' } });
 for (let i = 0; i < 2; i++) assert.equal((await ops.call('remote.status')).pairs.length, 0);
 const before = Date.now(), invitation = await ops.call('remote.invite');
 assert.deepEqual(Object.keys(invitation).sort(), ['expiresAt', 'pairId', 'uri']);
 assert.ok(invitation.expiresAt >= before + 600000 && invitation.expiresAt <= Date.now() + 600000);
 assert.ok(invitation.uri.startsWith('eve://pair?data='));
 const payload = JSON.parse(Buffer.from(invitation.uri.split('data=')[1], 'base64url'));
 const store = await RemoteStore.open(first);
 await store.bind(invitation.pairId, 'client', Date.now(), 'My phone');
 const status = await ops.call('remote.status'), serialized = JSON.stringify(status);
 for (const credential of [payload.secret, payload.routingToken, invitation.uri, 'registration-credential-for-test']) assert.equal(serialized.includes(credential), false);
 assert.equal(Object.hasOwn(status.settings, 'registrationKey'), false);
 assert.equal(status.settings.registrationConfigured, true);
 assert.equal(status.pairs[0].clientName, 'My phone');
 const revoked = await ops.call('remote.revoke', { pairId: invitation.pairId });
 assert.equal(revoked.pairs[0].revoked, true);
 await assert.rejects(store.bind(invitation.pairId, 'client'));
 // An omitted credential preserves the prior key.
 await configure(ops);
 assert.equal((await ops.call('remote.status')).settings.registrationConfigured, true);
});

test('external CLI writer locks reject every mutation without changing settings, while status reads', async t => {
 const { ops, first } = await fixture(t);
 await configure(ops);
 const store = await RemoteStore.open(first), release = await store.lock('connector.lock');
 try {
  for (const [op, params] of [
   ['remote.configure', { values: { allowWrite: true } }], ['remote.start', {}], ['remote.stop', {}], ['remote.invite', {}],
   ['remote.revoke', { pairId: '00000000-0000-0000-0000-000000000000' }]
  ]) await assert.rejects(ops.call(op, params), code('REMOTE_WRITER_BUSY'));
  const status = await ops.call('remote.status');
  assert.equal(status.settings.enabled, false); assert.equal(status.settings.allowWrite, false); assert.equal(status.pairs.length, 0);
 } finally { await release(); }
});

test('runtime projection honors PID/timestamp liveness and discards private nested fields', async t => {
 const { ops, first } = await fixture(t);
 await configure(ops);
 const file = path.join(first, '.eve/remote/runtime.json');
 await atomicPrivate(file, { pid: process.pid, updatedAt: Date.now(), enabled: true, token: 'hidden-runtime-token', connections: [{ pairId: 'pair', state: 'online', authenticated: 1, secret: 'hidden-peer-secret' }] });
 let status = await ops.call('remote.status');
 assert.equal(status.runtime.enabled, true); assert.equal(status.runtime.connections[0].authenticated, 1);
 assert.equal(JSON.stringify(status).includes('hidden-'), false);
 await atomicPrivate(file, { pid: process.pid, updatedAt: Date.now() - 10000, enabled: true });
 status = await ops.call('remote.status'); assert.equal(status.runtime.enabled, false);
 await atomicPrivate(file, { pid: 2147483647, updatedAt: Date.now(), enabled: true });
 assert.equal((await ops.call('remote.status')).runtime.enabled, false);
});

test('local busy rejects mutation but permits status; remote core sees management reservation', async t => {
 let connector, localBusy;
 const { ops, state } = await fixture(t, { createConnector: (_cwd, options) => {
  localBusy = options.localBusy;
  assert.equal(localBusy(), true);
  connector = new RemoteConnector(options.store, { localBusy });
  return connector;
 } });
 await configure(ops);
 state.localBusy = true;
 for (const op of ['remote.start', 'remote.stop', 'remote.invite', 'remote.configure']) {
  await assert.rejects(ops.call(op, op === 'remote.configure' ? { values: { allowWrite: true } } : {}), code('REMOTE_LOCAL_BUSY'));
 }
 assert.equal((await ops.call('remote.status')).settings.enabled, false);
 state.localBusy = false;
 await ops.call('remote.start');
 assert.equal(localBusy(), false); assert.equal(ops.isRemoteBusy(), false);
 state.localBusy = true; assert.equal(localBusy(), true); state.localBusy = false;
 connector.service.active = true; assert.equal(ops.isRemoteBusy(), true);
 await assert.rejects(ops.call('remote.configure', { values: { allowWrite: true } }), code('REMOTE_BUSY'));
 await assert.rejects(ops.call('remote.invite'), code('REMOTE_BUSY'));
 assert.equal((await ops.call('remote.status')).runtime.busy, true);
 connector.service.active = false;
 connector.service.running.set('queued', { controller: new AbortController() });
 assert.equal(ops.isRemoteBusy(), true);
 await assert.rejects(ops.call('remote.configure', { values: { allowWrite: true } }), code('REMOTE_BUSY'));
 connector.service.running.delete('queued');
 await ops.call('remote.stop'); assert.equal(ops.isRemoteBusy(), false);
});

test('single connector per workspace; start returns immediately; stop/restart/switch/EOF settle real connector', async t => {
 const created = [];
 const { ops, state, first, second } = await fixture(t, { createConnector: (_cwd, options) => {
  const c = new RemoteConnector(options.store, { localBusy: options.localBusy }); created.push(c); return c;
 } });
 await configure(ops);
 let status = await ops.call('remote.start');
 assert.equal(status.runtime.enabled, true); assert.equal(ops.isRemoteBusy(), false);
 await ops.call('remote.start'); assert.equal(created.length, 1);
 const external = await RemoteStore.open(first);
 await assert.rejects(external.lock('connector.lock'), /Remote writer already running/);
 status = await ops.call('remote.stop'); assert.equal(status.runtime.enabled, false); assert.equal(status.settings.enabled, false);
 await ops.call('remote.start'); assert.equal(created.length, 2);
 await ops.beforeWorkspaceSwitch(); assert.equal(created[1].enabled, false);
 const release = await external.lock('connector.lock'); await release();
 state.workspace = second;
 status = await ops.call('remote.status'); assert.equal(status.settings.relayUrl, ''); assert.equal(status.runtime.enabled, false);
 await configure(ops); await ops.call('remote.start'); assert.equal(created.length, 3);
 await ops.shutdown(); assert.equal(created[2].enabled, false);
 await assert.rejects(ops.call('remote.status'), code('REMOTE_CLOSING'));
 const secondStore = await RemoteStore.open(second), unlock = await secondStore.lock('connector.lock'); await unlock();
});

test('online invitation and revoke use connector; no inbound server needed', async t => {
 let connector;
 const { ops } = await fixture(t, { createConnector: (_cwd, options) => {
  connector = new RemoteConnector(options.store, { localBusy: options.localBusy });
  // Avoid a real relay while retaining real store, refresh, revoke and shutdown.
  connector.connect = tunnel => { tunnel.state = 'online'; };
  return connector;
 } });
 await configure(ops); await ops.call('remote.start');
 const invitation = await ops.call('remote.invite');
 assert.equal(connector.tunnels.has(invitation.pairId), true);
 assert.equal((await ops.call('remote.status')).runtime.connections[0].state, 'online');
 await ops.call('remote.revoke', { pairId: invitation.pairId });
 assert.equal(connector.tunnels.size, 0);
});

test('switch waits for connector cleanup and retains writer lease until service settles', async t => {
 const entered = deferred(), finish = deferred();
 const { ops, first } = await fixture(t, { createConnector: (_cwd, options) => {
  const c = new RemoteConnector(options.store, { localBusy: options.localBusy });
  const original = c.service.stop.bind(c.service);
  c.service.stop = async () => { entered.resolve(); await finish.promise; await original(); };
  return c;
 } });
 await configure(ops); await ops.call('remote.start');
 let done = false;
 const switching = ops.beforeWorkspaceSwitch().then(() => { done = true; });
 await entered.promise;
 assert.equal(done, false); assert.equal(ops.isRemoteBusy(), true);
 await assert.rejects(ops.call('remote.start'), code('REMOTE_CLOSING'));
 const external = await RemoteStore.open(first);
 await assert.rejects(external.lock('connector.lock'), /Remote writer already running/);
 finish.resolve(); await switching;
 assert.equal(done, true); assert.equal(ops.isRemoteBusy(), false);
 const release = await external.lock('connector.lock'); await release();
});

test('EOF drains in-flight management; concurrent mutation rejected; status remains readable', async t => {
 const entered = deferred(), finish = deferred();
 let pause = false;
 const { ops } = await fixture(t, { storeFactory: async cwd => {
  const store = await RemoteStore.open(cwd), original = store.configure.bind(store);
  store.configure = async values => { if (pause) { entered.resolve(); await finish.promise; } return original(values); };
  return store;
 } });
 await configure(ops); pause = true;
 const saving = ops.call('remote.configure', { values: { desktopName: 'Saved before EOF' } });
 await entered.promise;
 assert.equal(ops.isRemoteBusy(), true);
 await assert.rejects(ops.call('remote.invite'), code('REMOTE_LOCAL_BUSY'));
 assert.equal((await ops.call('remote.status')).settings.desktopName, 'Test Mac');
 let done = false; const closing = ops.shutdown().then(() => { done = true; });
 await Promise.resolve(); assert.equal(done, false);
 finish.resolve(); await saving; await closing; assert.equal(done, true);
});

test('shutdown drains an in-flight interval refresh before publishing final runtime and unlocking', async t => {
 const entered = deferred(), finish = deferred();
 let connector, pause = false;
 const { ops, first } = await fixture(t, { createConnector: (_cwd, options) => {
  connector = new RemoteConnector(options.store, { localBusy: options.localBusy });
  const original = connector.refresh.bind(connector);
  connector.refresh = async () => { if (pause) { entered.resolve(); await finish.promise; } await original(); };
  return connector;
 } });
 await configure(ops); await ops.call('remote.start'); pause = true;
 const refresh = connector.refresh(); await entered.promise;
 let done = false; const closing = ops.shutdown().then(() => { done = true; });
 await Promise.resolve(); assert.equal(done, false);
 const external = await RemoteStore.open(first);
 await assert.rejects(external.lock('connector.lock'), /Remote writer already running/);
 finish.resolve(); await refresh; await closing;
 const runtime = JSON.parse(await fs.readFile(path.join(first, '.eve/remote/runtime.json'), 'utf8'));
 assert.equal(runtime.enabled, false);
 assert.deepEqual(runtime.connections, []);
 const release = await external.lock('connector.lock'); await release();
});

test('unannounced workspace change rejected; read status never starts saved enabled connector', async t => {
 const { ops, state, first, second } = await fixture(t);
 await configure(ops);
 await ops.call('remote.configure', { values: { enabled: true } });
 assert.equal((await ops.call('remote.status')).runtime.enabled, false);
 state.workspace = second;
 await assert.rejects(ops.call('remote.status'), code('REMOTE_WORKSPACE_CHANGED'));
 state.workspace = first; await ops.beforeWorkspaceSwitch(); state.workspace = second;
 assert.equal((await ops.call('remote.status')).settings.enabled, false);
});
