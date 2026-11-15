import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {BridgeHost,bridgeError,OUTPUT_LIMIT} from '../macos/Bridge/host.mjs';
import {DEFAULTS,createStreamRedactor,inspectConfig} from '../src/config.mjs';
import {runAgent,chatCompletion} from '../src/agent.mjs';
import {openSession} from '../src/sessions.mjs';
async function setup(t,fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'done'},finish_reason:'stop'}]}))){
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'eve-host-ux-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
 const host=new BridgeHost({fetchImpl});t.after(()=>host.shutdown());return {cwd,host};
}
async function server(t,handler){const s=http.createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}/v1`;}
const frame=data=>`data: ${JSON.stringify(data)}\n\n`;
const delta=(content,finish_reason=null)=>frame({choices:[{delta:{content},finish_reason}]});
async function writeBytes(res,text){const bytes=Buffer.from(text);for(let i=0;i<bytes.length;i+=3){if(res.destroyed)return;res.write(bytes.subarray(i,i+3));await new Promise(r=>setImmediate(r));}}

test('broken local JSON remains selectable; explicit repair backs up bytes privately and validates schema',async t=>{
 const {cwd,host}=await setup(t);await fs.mkdir(path.join(cwd,'.eve'));const file=path.join(cwd,'.eve/config.local.json'),raw='{"apiKey":"PRIVATE-RAW", broken';await fs.writeFile(file,raw);
 const selected=await host.call('workspace',{path:cwd});assert.equal(selected.path,cwd);assert.equal(selected.configurationError.code,'CONFIG');
 const inspected=await host.call('config.inspect');assert.equal(inspected.valid,false);assert(!JSON.stringify(inspected).includes('PRIVATE-RAW'));
 await assert.rejects(host.call('run',{prompt:'x'}),e=>e.code==='CONFIG');
 await assert.rejects(host.call('config.repair',{values:{model:'fixed'}}));
 await assert.rejects(host.call('config.repair',{values:{unknown:'x'},confirm:true}));assert.equal(await fs.readFile(file,'utf8'),raw);
 await host.call('config.repair',{values:{model:'fixed'},confirm:true});assert.equal((await host.call('config.inspect')).valid,true);
 const dir=path.join(cwd,'.eve/evolution/config-backups'),files=await fs.readdir(dir);assert.equal(files.length,1);assert.equal(await fs.readFile(path.join(dir,files[0]),'utf8'),raw);assert.equal((await fs.stat(path.join(dir,files[0]))).mode&0o777,0o600);
 assert((await fs.readFile(path.join(cwd,'.gitignore'),'utf8')).includes('/.eve/evolution/config-backups/'));
});

test('invalid budget repair preserves credential and unrelated fields; public metadata and sources survive key substrings',async t=>{
 const {cwd,host}=await setup(t);await fs.mkdir(path.join(cwd,'.eve'));const file=path.join(cwd,'.eve/config.local.json');await fs.writeFile(file,JSON.stringify({apiKey:'model',model:'public-model-name',maxSteps:0,userSkills:false}));
 await host.call('workspace',{path:cwd});const c=await host.call('config.inspect');assert.equal(c.config.model,'public-model-name');assert.equal(c.config.apiKey,'[configured]');assert.equal(c.sources.model,file);assert.equal(c.valid,false);
 await assert.rejects(host.call('config.repair',{values:{model:'another'},confirm:true}));
 await host.call('config.repair',{values:{maxSteps:3},confirm:true});const raw=JSON.parse(await fs.readFile(file));assert.equal(raw.apiKey,'model');assert.equal(raw.userSkills,false);assert.equal((await host.call('config')).model,'public-model-name');
 const answer=await host.call('run',{prompt:'model'});assert.equal(answer.prompt,undefined);const page=await host.call('session.page',{sessionId:answer.sessionId});assert.equal(page.runs[0].prompt,'[redacted]');
});

test('inspect respects file then environment priority and does not expose unknown field contents',async t=>{
 const {cwd}=await setup(t);await fs.mkdir(path.join(cwd,'.eve'));await fs.writeFile(path.join(cwd,'.eve/config.json'),JSON.stringify({model:'shared'}));await fs.writeFile(path.join(cwd,'.eve/config.local.json'),JSON.stringify({model:'local',SECRET_UNKNOWN:'PRIVATE'}));
 const c=await inspectConfig({cwd,env:{EVE_MODEL:'environment'}});assert.equal(c.config.model,'environment');assert.equal(c.sources.model,'EVE_MODEL');assert.equal(c.valid,false);assert(!JSON.stringify(c).includes('PRIVATE'));
});

test('connection test uses only GET models, bounds body, exposes public IDs and classifies HTTP401',async t=>{
 let urls=[];const baseUrl=await server(t,(req,res)=>{urls.push([req.method,req.url,req.headers.authorization]);res.setHeader('Content-Type','application/json');if(urls.length===1)res.end(JSON.stringify({data:[{id:'public-key-model'}]}));else if(urls.length===2){res.statusCode=401;res.end('secret response');}else res.end('x'.repeat(300000));});
 const {cwd,host}=await setup(t,fetch);await host.call('workspace',{path:cwd});await host.call('configure',{values:{baseUrl}});await host.call('secret',{value:'key'});
 assert.deepEqual((await host.call('connection.test')).models,[{id:'public-key-model'}]);assert.equal((await host.call('connection.test')).error.code,'HTTP401');assert.equal((await host.call('connection.test')).error.code,'LIMIT');assert(urls.every(([method,url,auth])=>method==='GET'&&url==='/v1/models'&&auth==='Bearer key'));
 assert.equal(bridgeError(new Error('workspace busy')).code,'LOCK');assert.equal(bridgeError(new Error('预算无效')).code,'BUDGET');
});

test('session pages bound giant runs, preserve order; search messages, rename/archive and locked deletion',async t=>{
 const {cwd,host}=await setup(t);await host.call('workspace',{path:cwd});const session=await openSession(cwd,'pages');
 session.data.runs=[0,1,2,3].map(i=>({id:`r-${i}`,prompt:`prompt ${i}`,status:'completed',events:[],messages:[{role:'assistant',content:i===2?'needle inside answer':'answer'}],final:i===3?'巨'.repeat(600000):'done'}));await session.save();await session.close();
 const page=await host.call('session.page',{sessionId:'pages',limit:2});assert.equal(page.total,4);assert.equal(page.truncated,true);assert.equal(page.nextCursor,'2');assert.deepEqual(page.runs.map(r=>r.id),['r-2','r-3']);assert(Buffer.byteLength(JSON.stringify(page))<OUTPUT_LIMIT);
 assert.deepEqual((await host.call('session.page',{sessionId:'pages',cursor:page.nextCursor,limit:2})).runs.map(r=>r.id),['r-0','r-1']);await assert.rejects(host.call('session',{sessionId:'pages'}),e=>e.code==='LIMIT');assert(Array.isArray(await host.call('tools')));
 assert.equal((await host.call('sessions',{query:'needle'})).length,1);await host.call('session.rename',{sessionId:'pages',title:'Custom'});await host.call('session.archive',{sessionId:'pages',archived:true});assert.equal((await host.call('sessions')).length,0);const summary=(await host.call('sessions',{includeArchived:true}))[0];assert.equal(summary.title,'Custom');assert.equal(typeof summary.runs,'number');
 const lock=await openSession(cwd,'pages');await assert.rejects(host.call('session.delete',{sessionId:'pages',confirm:true}),/锁/);await lock.close();await assert.rejects(host.call('session.delete',{sessionId:'../pages',confirm:true}));await assert.rejects(host.call('session.delete',{sessionId:'pages'}));assert.equal((await host.call('session.delete',{sessionId:'pages',confirm:true})).writesReverted,false);
});

test('stream redactor handles every key split and safely flushes proper prefixes',()=>{
 const key='密钥-secret';for(let split=0;split<=key.length;split++){const r=createStreamRedactor({apiKey:key});assert.equal(r.push('before '+key.slice(0,split))+r.push(key.slice(split)+' after')+r.flush(),'before [redacted] after');}
 const r=createStreamRedactor({apiKey:key});assert.equal(r.push('密')+r.flush(),'密');
 const sanitized=createStreamRedactor({apiKey:'secret-key'});assert.equal(sanitized.push('sec\0')+sanitized.push('ret-key')+sanitized.flush(),'[redacted]');
 const ansi=createStreamRedactor({apiKey:'secret-key'});assert.equal(ansi.push('sec\x1b[31m')+ansi.push('ret-key')+ansi.flush(),'[redacted]');
});

test('real HTTP SSE splits UTF8, redacts cross-event secrets, joins tool arguments and accounts usage; JSON fallback stays compatible',async t=>{
 let requests=0;const baseUrl=await server(t,async(req,res)=>{let raw='';for await(const c of req)raw+=c;assert.equal(JSON.parse(raw).stream,true);requests++;res.setHeader('Content-Type',requests===1?'text/event-stream':'application/json');
 if(requests===1){const chunks=[delta('你好 sec'),delta('ret-key!'),frame({choices:[{delta:{reasoning_content:'DO-NOT-SHOW',tool_calls:[{index:0,id:'tool-1',type:'function',function:{name:'list_files',arguments:'{"pa'}}]},finish_reason:null}]}),frame({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'th":"."}'}}]},finish_reason:'tool_calls'}]}),frame({choices:[],usage:{prompt_tokens:7,completion_tokens:3}}),'data: [DONE]\n\n'];await writeBytes(res,chunks.join(''));res.end();}
 else res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'final secret-key'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}}));});
 const {cwd}=await setup(t);const events=[];const checkpoints=[];const result=await runAgent({cwd,config:{...DEFAULTS,baseUrl,apiKey:'secret-key',userSkills:false},prompt:'x',stream:true,onEvent:e=>events.push(e),onCheckpoint:e=>checkpoints.push(e)});
 assert.equal(result.status,'completed');assert.equal(result.stats.toolCalls,1);assert.equal(result.stats.promptTokens,9);assert.equal(result.final,'final [redacted]');const transient=events.filter(e=>e.type==='assistant_delta');assert.equal(transient.map(e=>e.text).join(''),'你好 [redacted]!final [redacted]');assert(!JSON.stringify(transient).includes('DO-NOT-SHOW'));assert(!checkpoints.some(c=>c.event.type==='assistant_delta'));assert(!result.events.some(e=>e.type==='assistant_delta'));
});

test('SSE cancellation and partial/length failures cannot execute truncated tools or leak held credentials',async t=>{
 let mode='partial';const baseUrl=await server(t,async(req,res)=>{for await(const c of req){}res.setHeader('Content-Type','text/event-stream');const text=delta('safe sec')+frame({choices:[{delta:{tool_calls:[{index:0,id:'bad',type:'function',function:{name:'write_file',arguments:'{"path":"never.txt","content":"bad"}'}}]},finish_reason:mode==='length'?'length':null}]});await writeBytes(res,text);if(mode==='cancel')return;res.end();});
 const {cwd}=await setup(t);const config={...DEFAULTS,baseUrl,apiKey:'secret-key',userSkills:false};
 for(mode of ['partial','length','cancel']){const controller=new AbortController(),events=[];const result=await runAgent({cwd,config,prompt:'x',stream:true,signal:controller.signal,onEvent:e=>{events.push(e);if(mode==='cancel'&&e.type==='assistant_delta')controller.abort();}});assert.equal(result.status,mode==='cancel'?'cancelled':'failed');assert.equal(result.stats.toolCalls,0);assert(!events.filter(e=>e.type==='assistant_delta').map(e=>e.text).join('').includes(mode==='length'?'secret-key':'sec'));await assert.rejects(fs.stat(path.join(cwd,'never.txt')));}
});

test('repair refuses external/global configuration and schema prototype keys without changing private bytes',async t=>{
 const {cwd,host}=await setup(t);await fs.mkdir(path.join(cwd,'.eve'));const file=path.join(cwd,'.eve/config.local.json');await fs.writeFile(file,'{"maxSteps":0,"apiKey":"preserved"}');
 const external=path.join(cwd,'external.json');await fs.writeFile(external,'{broken external');const previous=process.env.EVE_CONFIG;process.env.EVE_CONFIG=external;t.after(()=>{if(previous===undefined)delete process.env.EVE_CONFIG;else process.env.EVE_CONFIG=previous;});
 await host.call('workspace',{path:cwd});await assert.rejects(host.call('config.repair',{values:{maxSteps:3},confirm:true}),e=>e.code==='CONFIG');assert.equal(await fs.readFile(external,'utf8'),'{broken external');assert.equal(JSON.parse(await fs.readFile(file)).maxSteps,0);
 delete process.env.EVE_CONFIG;await assert.rejects(host.call('config.repair',{values:JSON.parse('{"__proto__":{},"maxSteps":3}'),confirm:true}));assert.equal(JSON.parse(await fs.readFile(file)).apiKey,'preserved');
});

test('connection model-list timeout is actually capped at ten seconds',async t=>{
 const baseUrl=await server(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{"data":[');});
 const {cwd,host}=await setup(t,fetch);await host.call('workspace',{path:cwd});await host.call('configure',{values:{baseUrl}});const start=Date.now(),result=await host.call('connection.test');assert.equal(result.error.code,'TIMEOUT');assert(Date.now()-start>=9900&&Date.now()-start<12500);assert(result.latencyMs>=9900&&result.latencyMs<12500);assert(Array.isArray(await host.call('tools')));
});

test('actual JSONL process bounds output and serves tools after huge legacy session error',async t=>{
 const {spawn}=await import('node:child_process');const {createInterface}=await import('node:readline');const {cwd}=await setup(t);const ledger=await openSession(cwd,'oversize');ledger.data.runs=[{id:'giant',status:'completed',prompt:'hello',messages:[],events:[],final:'大'.repeat(800000)}];await ledger.save();await ledger.close();
 const child=spawn(process.execPath,['macos/Bridge/main.mjs'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());let frames=[],stderr='',waiting=new Map();child.stderr.on('data',b=>stderr+=b);const lines=createInterface({input:child.stdout});lines.on('line',line=>{assert(Buffer.byteLength(line)<512*1024);const frame=JSON.parse(line);frames.push(frame);if(frame.type!=='event')waiting.get(frame.requestID)?.(frame);});
 let id=0;const call=(op,params={})=>new Promise((resolve,reject)=>{const requestID=`r${++id}`;const timer=setTimeout(()=>reject(new Error('protocol response timeout')),5000);waiting.set(requestID,frame=>{clearTimeout(timer);waiting.delete(requestID);resolve(frame);});child.stdin.write(JSON.stringify({requestID,op,params})+'\n');});
 assert.equal((await call('workspace',{path:cwd})).type,'result');assert.equal((await call('session',{sessionId:'oversize'})).error.code,'LIMIT');assert.equal((await call('session.page',{sessionId:'oversize'})).result.truncated,true);assert.equal((await call('session.delete',{sessionId:'../no',confirm:true})).error.code,'VALIDATION');assert.equal((await call('tools')).type,'result');
 const closed=once(child,'close');child.stdin.end();await closed;assert.equal(child.exitCode,0);assert.equal(stderr,'');assert(frames.every(f=>f.requestID));
});

test('host remote routing exposes invitation only explicitly and obeys lifecycle/busy boundaries',async t=>{
 const {cwd,host}=await setup(t);await host.call('workspace',{path:cwd});await host.call('remote.configure',{values:{relayUrl:'https://relay.example.com',registrationKey:'PRIVATE-REGISTRATION'}});const invite=await host.call('remote.invite');assert(invite.uri.startsWith('eve://pair?data='));const payload=JSON.parse(Buffer.from(invite.uri.split('data=')[1],'base64url'));
 const status=JSON.stringify(await host.call('remote.status'));for(const value of [invite.uri,payload.secret,payload.routingToken,'PRIVATE-REGISTRATION'])assert(!status.includes(value));
 const real=host.remote;let switched=false,stopped=false;host.remote={isRemoteBusy:()=>true,beforeWorkspaceSwitch:async()=>{switched=true;await real.beforeWorkspaceSwitch();},shutdown:async()=>{stopped=true;await real.shutdown();},call:(...args)=>real.call(...args)};
 await assert.rejects(host.call('run',{prompt:'blocked'}),/busy/);await host.call('workspace',{path:cwd});assert(switched);await host.shutdown();assert(stopped);
});
