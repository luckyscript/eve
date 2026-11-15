import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RemoteConnector } from '../src/remote.mjs';
import { TestClient } from './test-client.mjs';
import { startRelay,revision } from './dev-relay.mjs';
const wait=async(fn,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('Wait timeout');};
test('pinned Alma Relay protocol 1: encrypted operations, rejection, once-only writes, reconnect and revoke',async t=>{
 const relay=await startRelay();
 const cwd=await fs.mkdtemp(path.resolve('.eve/verify-remote-integration-'));
 const connectors=[],clients=[];t.after(async()=>{for(const x of clients)x.close();for(const x of connectors)await x.stop();await relay.stop();await fs.rm(cwd,{recursive:true,force:true});});
 let calls=0;const fakeFetch=async(_url,options)=>{calls++;const q=JSON.parse(options.body);const tool=q.messages.at(-1)?.role==='tool';return Response.json({choices:[{finish_reason:tool?'stop':'tool_calls',message:{role:'assistant',content:tool?'Created artifact.':null,...(!tool?{tool_calls:[{id:'write-one',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'artifact.txt',content:'exactly once'})}}]}:{})}}]});};
 const connector=await RemoteConnector.create(cwd,{fetchImpl:fakeFetch});connectors.push(connector);
 await connector.store.configure({enabled:true,relayUrl:relay.url,development:true,allowWrite:true});const pair=await connector.store.invite();await connector.start();
 await wait(()=>connector.status().connections[0]?.state==='online');
 const c=await TestClient.connect(pair);clients.push(c);
 const info=await c.request('desktop.info');assert.equal(info.ok,true);assert.equal(info.result.protocol,1);
 const req=randomUUID(),params={prompt:'Write artifact.txt'};const run=await c.request('run.start',params,req);assert.equal(run.ok,true);assert.equal(run.result.status,'completed');assert.equal(calls,2);
 assert.equal(await fs.readFile(path.join(cwd,'artifact.txt'),'utf8'),'exactly once');
 const dup=await c.request('run.start',params,req);assert.equal(dup.result.runId,run.result.runId);assert.equal(calls,2);
 assert.equal((await c.request('run.start',{prompt:'conflict'},req)).ok,false);
 const lookup=await c.request('run.lookup',{requestId:req});assert.equal(lookup.result.state,'completed');
 assert.equal((await c.request('sessions.get',{sessionId:run.result.sessionId})).result.runs.length,1);
 assert.equal((await c.request('config',{})).ok,false);assert.equal((await c.request('run.start',{prompt:'x',contractName:'not-allowed'})).ok,false);
 assert.equal((await c.request('context.compact',{sessionId:run.result.sessionId})).ok,false);
 await assert.rejects(()=>TestClient.connect(pair,{secret:Buffer.alloc(32,9).toString('base64url')}));
 await assert.rejects(()=>TestClient.connect(pair));
 const pair2=await connector.store.invite();await connector.refresh();await wait(()=>connector.status().connections.find(x=>x.pairId===pair2.pairId)?.state==='online');
 const other=await TestClient.connect(pair2);clients.push(other);
 assert.equal((await other.request('run.lookup',{requestId:req})).ok,false);
 assert.equal((await other.request('sessions.get',{sessionId:run.result.sessionId})).ok,false);
 // Break only transport. The connector reconnects with fresh authentication, without replaying tasks.
 const tunnel=connector.tunnels.get(pair.pairId);tunnel.socket.close();await wait(()=>c.closed);await wait(()=>tunnel.state==='online');
 const resumed=await TestClient.connect(pair,{clientId:c.clientId});clients.push(resumed);assert.equal((await resumed.request('run.lookup',{requestId:req})).result.state,'completed');assert.equal(calls,2);
 // Strict sequence replay closes the encrypted channel.
 const frame=resumed.output.encrypt({kind:'request',id:randomUUID(),op:'desktop.info',params:{}});resumed.send(frame);resumed.send(frame);await wait(()=>resumed.closed);
 const revoked=await TestClient.connect(pair,{clientId:c.clientId});clients.push(revoked);await connector.revoke(pair.pairId);await wait(()=>revoked.closed);
 // Pending ledger survives restart as unknown; an identical request does not call the model.
 const interrupted=randomUUID(),pending={prompt:'never replay'};await connector.store.begin(pair2.pairId,interrupted,'run.start',pending);
 await connector.stop();other.close();
 const next=await RemoteConnector.create(cwd,{fetchImpl:fakeFetch});connectors.push(next);await next.start();await wait(()=>next.status().connections[0]?.state==='online');const after=await TestClient.connect(pair2,{clientId:other.clientId});clients.push(after);
 assert.equal((await after.request('run.lookup',{requestId:interrupted})).result.state,'unknown');assert.equal((await after.request('run.start',pending,interrupted)).result.state,'unknown');assert.equal(calls,2);
 const logs=relay.logs();for(const p of [pair,pair2]){assert.ok(!logs.includes(p.secret));assert.ok(!logs.includes(p.routingToken));}
 const runtime=await fs.readFile(path.join(cwd,'.eve/remote/runtime.json'),'utf8');assert.ok(!runtime.includes(pair2.secret));assert.ok(!runtime.includes(pair2.routingToken));
 console.log(`Verified real Alma Relay ${revision}; simulated model calls=${calls}; no credentials in relay/runtime logs.`);
});
