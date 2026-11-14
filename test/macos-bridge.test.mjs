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
 const child=spawn('/usr/local/bin/node',[process.env.EVE_TEST_BRIDGE || 'macos/Bridge/main.mjs'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
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

test('bridge actual APIs cover tools, compression, evolution scores, promote, rollback and one-shot auto evolution',async t=>{
 let generations=0; const captures=[];
 const skillText=body=>`---\nname: native-proof\ndescription: Native proof fixture\n---\n${body}\n`;
 const mock=async (_url,init)=>{
  const q=JSON.parse(init.body); captures.push(q);
  if(!q.tools) {generations++; return response(skillText('improved procedure'));}
  const tools=q.messages.filter(m=>m.role==='tool');
  let name,args;
  if(!tools.length) {name='load_skill';args={name:'native-proof'};}
  else if(tools.length===1) {name='write_file';args={path:'out.txt',content:tools[0].content.includes('improved procedure')?'good':'bad'};}
  else return response('done');
  return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'t'+tools.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'stop'}]}));
 };
 const {cwd,h}=await host(t,mock);await h.call('workspace',{path:cwd});
 await h.call('configure',{values:{maxSteps:3,userSkills:false,maxOutputTokens:512}});
 await fs.mkdir(path.join(cwd,'skills/native-proof'),{recursive:true});const skillFile=path.join(cwd,'skills/native-proof/SKILL.md');await fs.writeFile(skillFile,skillText('old procedure'));
 const baseline=await h.call('import',{file:skillFile}); assert.equal(baseline.status,'active');
 const contract={version:1,assertions:[{type:'text_equals',path:'out.txt',text:'good'},{type:'write_readback',path:'out.txt'}]};
 const contractFile=path.join(cwd,'contract.json');await fs.writeFile(contractFile,JSON.stringify(contract));
 const suiteFile=path.join(cwd,'suite.json');await fs.writeFile(suiteFile,JSON.stringify({version:1,maxCandidates:3,budget:{maxSteps:3,maxToolCalls:4,maxOutputTokens:512,timeoutMs:10000},cases:[{id:'hidden',prompt:'Use native-proof to write out.txt',files:{'input.txt':'PRIVATE_SUITE_CANARY'},contract}]}));
 const source=await h.call('run',{prompt:'Use native-proof to write out.txt',contractFile,sessionId:'evolution-source'});assert.equal(source.verification.status,'failed');
 assert.equal((await h.call('suite',{file:suiteFile})).requestCeiling,7);
 const args={sessionId:source.sessionId,runId:source.runId,skill:'native-proof',suiteFile,maxRequests:10,autoPromote:false,correction:''};
 const evolved=await h.call('evolve',args);assert.equal(evolved.status,'evaluated');assert.equal(evolved.evaluation.cases[0].baseline.passed,false);assert.equal(evolved.evaluation.cases[0].candidate.passed,true);
 assert(!JSON.stringify(captures.find(q=>!q.tools)).includes('PRIVATE_SUITE_CANARY'));assert(!JSON.stringify(captures.find(q=>!q.tools)).includes('assertions'));
 assert.equal((await h.call('promote',{id:evolved.candidate.id})).status,'active');
 assert.equal((await h.call('rollback',{name:'native-proof'})).active,baseline.hash);
 const auto=await h.call('run',{prompt:'Use native-proof to write out.txt',contractFile,autoEvolve:true,skill:'native-proof',suiteFile,maxRequests:10,autoPromote:false,correction:''});
 assert.equal(auto.evolution.status,'evaluated');assert.equal(await fs.readFile(path.join(cwd,'out.txt'),'utf8'),'bad');assert.equal(generations,2);
 const experiments=await h.call('experiments',{});assert.equal(experiments.length,2);assert(experiments.every(e=>e.evaluation.cases[0].candidate.passed));
 const compressed=await h.call('compact',{sessionId:source.sessionId});assert.equal(compressed.status,'completed');assert.equal(compressed.context.summary,true);
 let entered;const started=new Promise(resolve=>entered=resolve);
 h.fetchImpl=async (_u,init)=>{entered();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('cancelled generation')),{once:true}));};
 const cancelling=h.call('evolve',args,'cancel-evolution');const rejected=assert.rejects(cancelling);await started;await h.call('cancel',{requestID:'cancel-evolution'});await rejected;
 const records=await h.call('experiments',{});assert.equal(records.filter(x=>x.status==='failed').length,1);assert.equal((await h.call('capabilities',{})).active['native-proof'],baseline.hash);
});

test('bridge handles a closed stdout pipe without an uncaught exception',async t=>{
 const {spawn}=await import('node:child_process');
 const child=spawn('/usr/local/bin/node',[process.env.EVE_TEST_BRIDGE || 'macos/Bridge/main.mjs'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());
 let stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.destroy();
 for(let i=0;i<20;i++)child.stdin.write(JSON.stringify({requestID:'closed-'+i,op:'busy'})+'\n');child.stdin.end();
 await new Promise(resolve=>child.on('close',resolve));assert(!stderr.includes('Unhandled'));assert(!stderr.includes('throw er;'));
});

test('bridge omits unavailable evolution and error fields rather than inventing null outcomes',async t=>{
 const {cwd,h}=await host(t);await h.call('workspace',{path:cwd});const result=await h.call('run',{prompt:'hello'});
 assert(!Object.hasOwn(result,'evolution'));assert(!Object.hasOwn(result,'error'));
});

test('secret settings ensure ignore rules in the chosen workspace and reject symlink ignore files',async t=>{
 const {cwd,h}=await host(t);await h.call('workspace',{path:cwd});await h.call('secret',{value:'new-private-value'});
 assert((await fs.readFile(path.join(cwd,'.gitignore'),'utf8')).includes('.eve/config.local.json'));
 await fs.rm(path.join(cwd,'.gitignore'));await fs.writeFile(path.join(cwd,'other-ignore'),'');await fs.symlink(path.join(cwd,'other-ignore'),path.join(cwd,'.gitignore'));
 await assert.rejects(h.call('secret',{value:'not-saved'}));
});
test('secret settings refuse an already tracked local configuration',async t=>{
 const {execFileSync}=await import('node:child_process');const {cwd,h}=await host(t);
 execFileSync('/usr/bin/git',['init','-q'],{cwd});await fs.mkdir(path.join(cwd,'.eve'));await fs.writeFile(path.join(cwd,'.eve/config.local.json'),'{}');
 execFileSync('/usr/bin/git',['add','-f','--','.eve/config.local.json'],{cwd});await h.call('workspace',{path:cwd});
 await assert.rejects(h.call('secret',{value:'must-not-be-written'}));assert.equal(await fs.readFile(path.join(cwd,'.eve/config.local.json'),'utf8'),'{}');
});
