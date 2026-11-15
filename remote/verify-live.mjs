// Explicit paid verification. Hard ceiling: 12 provider HTTP requests, no retries.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { RemoteConnector } from '../src/remote.mjs';
import { TestClient } from './test-client.mjs';
import { startRelay,revision } from './dev-relay.mjs';
let calls=0;const maxRequests=12;let connector,relay,client;
const cwd=await fs.mkdtemp(path.resolve('.eve/verify-remote-live-'));
const evidence={relayRevision:revision,transport:'actual pinned relay, protocol 1, mutual PSK authentication + encrypted application channel',maxRequests,workspace:path.relative(process.cwd(),cwd),startedAt:new Date().toISOString()};
try{
 const config=await loadConfig({cwd:process.cwd()});
 await fs.mkdir(path.join(cwd,'.eve'),{mode:0o700});
 await fs.writeFile(path.join(cwd,'.eve/config.local.json'),JSON.stringify({...config,maxSteps:4,maxToolCalls:6,userSkills:false,skillsDirs:[],timeoutMs:120000}),{mode:0o600});
 const contract={version:1,assertions:[{type:'text_equals',path:'relay-proof.txt',text:'eve remote real model verified\n'},{type:'write_readback',path:'relay-proof.txt'}]};
 await fs.writeFile(path.join(cwd,'.eve/acceptance.json'),JSON.stringify(contract),{mode:0o600});
 relay=await startRelay();connector=await RemoteConnector.create(cwd,{fetchImpl:async(url,options)=>{if(calls>=maxRequests)throw new Error('Live verification request ceiling');calls++;return fetch(url,options);}});
 await connector.store.configure({enabled:true,relayUrl:relay.url,development:true,allowWrite:true,contracts:{proof:'.eve/acceptance.json'}});
 const invite=await connector.store.invite();await connector.start();
 for(let n=0;n<100&&connector.status().connections[0]?.state!=='online';n++)await new Promise(r=>setTimeout(r,50));
 client=await TestClient.connect(invite);
 const run=await client.request('run.start',{prompt:'Use write_file to create relay-proof.txt with exactly this UTF-8 content, including the final newline: "eve remote real model verified\\n". Do not write any other file. Then finish briefly.',contractName:'proof'});
 assert.equal(run.ok,true);assert.equal(run.result.status,'completed');assert.equal(run.result.verification.status,'passed');assert.equal(await fs.readFile(path.join(cwd,'relay-proof.txt'),'utf8'),'eve remote real model verified\n');
 const follow=await client.request('run.start',{sessionId:run.result.sessionId,prompt:'Continue our existing conversation. Read relay-proof.txt using read_file, confirm its exact text and that this is the file from the previous task. Do not write or edit anything. Finish briefly.'});
 assert.equal(follow.ok,true);assert.equal(follow.result.status,'completed');
 const session=await client.request('sessions.get',{sessionId:run.result.sessionId});assert.equal(session.result.runs.length,2);
 const ledger=JSON.parse(await fs.readFile(path.join(cwd,'.eve/sessions',run.result.sessionId+'.json'),'utf8'));
 assert.ok(ledger.runs[1].tools.some(t=>t.name==='read_file'&&t.result?.ok));assert.ok(ledger.runs[1].messages.some(m=>m.role==='user'&&m.content.includes('Use write_file')));
 Object.assign(evidence,{passed:true,modelRequests:calls,sessionId:run.result.sessionId,newSessionRun:{status:run.result.status,verification:run.result.verification.status,stats:run.result.stats},continuedRun:{status:follow.result.status,stats:follow.result.stats},independentFileReadback:true,persistedHistory:true});
 console.log(JSON.stringify(evidence,null,2));
}catch(e){Object.assign(evidence,{passed:false,modelRequests:calls,error:'Live verification failed; inspect private local evidence.'});console.log(JSON.stringify(evidence,null,2));process.exitCode=1;}
finally{client?.close();await connector?.stop();await relay?.stop();evidence.finishedAt=new Date().toISOString();await fs.writeFile(path.join(cwd,'report.json'),JSON.stringify(evidence,null,2),{mode:0o600});}
