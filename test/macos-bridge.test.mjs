import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeHost } from '../macos/Bridge/host.mjs';
const response = content => new Response(JSON.stringify({choices:[{message:{role:'assistant',content},finish_reason:'stop'}]}));
async function host(t, fetchImpl = async () => response('done')) {
 const cwd = await fs.mkdtemp(path.resolve('.eve/verify-macos-'));
 t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
 return {cwd, h:new BridgeHost({fetchImpl})};
}
test('bridge pins workspace, validates operations, projects secrets and persists sessions', async t=>{
 const {cwd,h}=await host(t);
 await h.call('workspace',{path:cwd});
 await h.call('secret',{value:'private-key-314'});
 const c=await h.call('config',{}); assert.equal(c.apiKey,'[configured]');
 assert.equal((await fs.stat(path.join(cwd,'.eve/config.local.json'))).mode&0o777,0o600);
 await assert.rejects(h.call('arbitrary',{})); await assert.rejects(h.call('run',{prompt:'x',unexpected:true}));
 const r=await h.call('run',{prompt:'hello',sessionId:'native'}); assert.equal(r.status,'completed'); assert(!('messages' in r));
 const s=await h.call('session',{sessionId:'native'}); assert.equal(s.runs.length,1); assert(!JSON.stringify(s).includes('rawArguments'));
 assert.equal((await h.call('sessions',{})).length,1); assert.equal((await h.call('status',{sessionId:'native'})).runs,1);
 assert(Array.isArray(await h.call('tools',{}))); assert(Array.isArray((await h.call('skills',{})).skills));
 assert((await h.call('capabilities',{})).active);
});
test('bridge blocks workspace switch while busy and cancellation settles without replay',async t=>{
 const {cwd,h}=await host(t,(_u,o)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})));
 await h.call('workspace',{path:cwd});
 const pending=h.call('run',{prompt:'wait'},'slow');
 await new Promise(r=>setTimeout(r,80));
 assert.equal((await h.call('busy',{})).busy,true);
 await assert.rejects(h.call('workspace',{path:cwd}),/busy/);
 await h.call('cancel',{requestID:'slow'});
 assert.equal((await pending).status,'cancelled'); assert.equal((await h.call('busy',{})).busy,false);
});
test('bridge validates contract/suite in host and rejects invalid evolution before requests',async t=>{
 const {cwd,h}=await host(t); await h.call('workspace',{path:cwd});
 const file=path.join(cwd,'contract.json'); await fs.writeFile(file,JSON.stringify({version:1,assertions:[{type:'file_exists',path:'missing'}]}));
 assert.equal((await h.call('contract',{file})).assertions,1);
 const r=await h.call('run',{prompt:'done',contractFile:file}); assert.equal(r.verification.status,'failed');
 await assert.rejects(h.call('suite',{file}),/suite/);
 await assert.rejects(h.call('evolve',{sessionId:r.sessionId,runId:r.runId,skill:'probe',suiteFile:file,maxRequests:0}));
 await assert.rejects(h.call('promote',{id:'absent'})); await assert.rejects(h.call('rollback',{name:'absent'}));
});

test('bridge JSONL actual subprocess rejects malformed/oversized frames and serves multiple requests',async t=>{
 const {spawn}=await import('node:child_process');
 const {cwd}=await host(t);
 const child=spawn('/usr/local/bin/node',['macos/Bridge/main.mjs'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
 t.after(()=>child.kill()); let output=''; child.stdout.on('data',b=>{output+=b});
 const wait=async id=>{for(let n=0;n<300;n++){const found=output.split('\n').filter(Boolean).map(x=>JSON.parse(x)).find(x=>x.requestID===id&&x.type!=='event');if(found)return found;await new Promise(r=>setTimeout(r,10));}throw new Error('bridge response timeout');};
 child.stdin.write(JSON.stringify({requestID:'w',op:'workspace',params:{path:cwd}})+'\n'); assert.equal((await wait('w')).type,'result');
 child.stdin.write('{broken}\n'+ 'x'.repeat(270000)+'\n');
 child.stdin.write(JSON.stringify({requestID:'c',op:'config'})+'\n'); assert.equal((await wait('c')).result.apiKey,'[not configured]');
 child.stdin.end(); await new Promise(r=>child.on('close',r));
 assert(output.includes('PROTOCOL'));assert(output.includes('LIMIT'));assert(!output.includes('headers'));
});

test('bridge recursively redacts secrets even with JSON escapes; tool private data never projected',async t=>{
 const secret='s"e\\cret'; const {cwd,h}=await host(t,async()=>response(secret)); await h.call('workspace',{path:cwd}); await h.call('secret',{value:secret});
 const r=await h.call('run',{prompt:'hello'}); assert.equal(r.final,'[redacted]'); assert(!JSON.stringify(r).includes('messages')); assert(!JSON.stringify(r).includes('rawArguments'));
});
