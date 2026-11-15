// Local emulator integration fixture; never use this loopback setup as a public deployment.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { RemoteConnector } from '../src/remote.mjs';
import { startRelay, revision } from './dev-relay.mjs';
const cwd = await fs.mkdtemp(path.resolve('.eve/verify-android-e2e-'));
const config = await loadConfig({ cwd: process.cwd() });
await fs.mkdir(path.join(cwd, '.eve'), { mode: 0o700 });
const configFile = path.join(cwd, '.eve/config.local.json');
await fs.writeFile(configFile, JSON.stringify({ ...config, maxSteps: 4, maxToolCalls: 6, timeoutMs: 120000, userSkills: false, skillsDirs: [] }), { mode: 0o600 });
let requests = 0;
const relay = await startRelay(8787);
const connector = await RemoteConnector.create(cwd, { fetchImpl: async (url, options) => {
  if (++requests > 6) throw new Error('Android fixture request ceiling');
  return fetch(url, options);
} });
await connector.store.configure({ enabled: true, relayUrl: relay.url, development: true, allowWrite: true, allowCompact: false, desktopName: 'Eve integration desktop' });
await connector.start();
const invite = await connector.invite();
await fs.mkdir('.eve/runs', { recursive: true });
await fs.writeFile('.eve/runs/android-fixture.json', JSON.stringify({ uri: invite.uri, workspace: cwd, port: 8787, pid: process.pid }), { mode: 0o600 });
console.log('Android fixture ready; credential stored only in ignored private fixture file.');
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await connector.stop(); await relay.stop();
  await fs.rm(configFile, { force: true });
  await fs.writeFile('.eve/runs/android-fixture-result.json', JSON.stringify({ revision, requests, workspace: path.relative(process.cwd(), cwd), endedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop().catch(() => { process.exitCode = 1; }));
