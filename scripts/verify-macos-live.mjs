import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
const root=path.resolve(import.meta.dirname,'..');
const app=path.join(root,'dist/Eve.app/Contents/Resources');
const node=path.join(app,'runtime/node'), bridge=path.join(app,'bridge/Bridge/main.mjs');
const reportFile=path.join(root,'.eve/runs/macos-live-verification.json');
const audit=path.join(root,'.eve/runs/macos-live-requests.jsonl');
await fs.rm(audit,{force:true});
const workspace=await fs.mkdtemp(path.join(root,'.eve/verify-macos-live-'));
await fs.chmod(workspace,0o700); await fs.mkdir(path.join(workspace,'.eve'),{mode:0o700});
const config=await loadConfig({cwd:root});
await fs.writeFile(path.join(workspace,'.eve/config.local.json'),JSON.stringify({...config,maxSteps:8,maxOutputTokens:1024,timeoutMs:240000,skillsDirs:['skills'],userSkills:false}),{mode:0o600});
const nonce=randomUUID(),marker='SKILL_'+randomUUID();
await fs.mkdir(path.join(workspace,'skills/workspace-report'),{recursive:true});
await fs.writeFile(path.join(workspace,'skills/workspace-report/SKILL.md'),(await fs.readFile(path.join(root,'skills/workspace-report/SKILL.md'),'utf8'))+`\nAdd proof field with exact value ${marker}.\n`);
await fs.writeFile(path.join(workspace,'inventory.txt'),nonce+'\n');
const contract=(file,assertions)=>({version:1,assertions:[...assertions,{type:'write_readback',path:file}]});
await fs.writeFile(path.join(workspace,'contract.json'),JSON.stringify(contract('report.json',[{type:'json_equals',path:'report.json',field:['items'],value:[nonce]},{type:'json_equals',path:'report.json',field:['proof'],value:marker}])));
await fs.writeFile(path.join(workspace,'continue-contract.json'),JSON.stringify(contract('continue.json',[{type:'json_equals',path:'continue.json',field:['nonce'],value:nonce}])));
await fs.writeFile(path.join(workspace,'ui-contract.json'),JSON.stringify(contract('ui-proof.txt',[{type:'text_equals',path:'ui-proof.txt',text:'native-ui-proof'}])));
class RPC {
 constructor(){
  this.pending=new Map();this.events=[];this.buffer='';
  this.child=spawn(node,[bridge],{cwd:root,env:{HOME:process.env.HOME,EVE_REQUEST_AUDIT:audit,EVE_REQUEST_LIMIT:'18'},stdio:['pipe','pipe','pipe']});
  this.child.stderr.resume();this.closed=new Promise(resolve=>this.child.on('close',resolve));
  this.child.stdout.on('data',data=>{this.buffer+=data;let i;while((i=this.buffer.indexOf('\n'))>=0){const q=JSON.parse(this.buffer.slice(0,i));this.buffer=this.buffer.slice(i+1);if(q.type==='event'){this.events.push(q.event);continue;}const p=this.pending.get(q.requestID);this.pending.delete(q.requestID);q.type==='result'?p?.resolve(q.result):p?.reject(new Error('packaged_bridge_operation_failed'));}});
  this.child.on('exit',()=>{for(const p of this.pending.values())p.reject(new Error('bridge_exited'));this.pending.clear();});
 }
 call(op,params={}){const requestID=randomUUID();return new Promise((resolve,reject)=>{this.pending.set(requestID,{resolve,reject});this.child.stdin.write(JSON.stringify({requestID,op,params})+'\n');});}
 async close(){this.child.stdin.end();await this.closed;}
}
const summary=r=>({status:r.status,modelStatus:r.modelStatus,verification:r.verification?.status,stats:r.stats,events:r.events.map(e=>({type:e.type,name:e.name,ok:e.ok}))});
const fingerprint=createHash('sha256');
for(const dir of ['src','bridge/Bridge']) for(const file of (await fs.readdir(path.join(app,dir))).filter(f=>f.endsWith('.mjs')).sort()) fingerprint.update(dir+'/'+file).update(await fs.readFile(path.join(app,dir,file)));
const report={coreBridgeHash:fingerprint.digest('hex'),at:new Date().toISOString(),sourceRevision:(await fs.readFile(path.join(app,'source-revision.txt'),'utf8')).trim(),bridgeHash:createHash('sha256').update(await fs.readFile(bridge)).digest('hex'),passed:false,checks:{},runs:[],workspace:path.relative(root,workspace)};
let rpc;
try {
 console.log('packaged bridge: skills + task tools + independent contract');
 rpc=new RPC();await rpc.call('workspace',{path:workspace});
 report.checks.skillDiscovery=(await rpc.call('skills')).skills.some(s=>s.name==='workspace-report');
 const first=await rpc.call('run',{sessionId:'native-live',prompt:'使用 workspace-report 技能，依据 inventory.txt 生成 report.json，写后读回核验。记住 inventory 的唯一条目用于后续会话。',contractFile:path.join(workspace,'contract.json')});
 report.runs.push(summary(first));assert.equal(first.verification.status,'passed');
 report.checks.skillLoaded=first.events.some(e=>e.name==='load_skill'&&e.ok);
 report.checks.toolReadback=first.events.some(e=>e.name==='read_file'&&e.ok);
 report.checks.taskAccepted=first.status==='completed';await rpc.close();rpc=null;
 console.log('packaged bridge: new process continues durable session');
 rpc=new RPC();await rpc.call('workspace',{path:workspace});
 const next=await rpc.call('run',{sessionId:'native-live',prompt:'用上一轮记住的 inventory 唯一条目作为 nonce，创建 continue.json，内容是 {"nonce":上一轮条目字符串}。写后读取核验。',contractFile:path.join(workspace,'continue-contract.json')});
 report.runs.push(summary(next));report.checks.newProcessContinuation=next.verification.status==='passed';assert(report.checks.newProcessContinuation);
 const compact=await rpc.call('compact',{sessionId:'native-live'});report.checks.compression=compact.status==='completed'&&compact.context.summary===true;
 report.checks.sessionProjection=!('messages' in (await rpc.call('session',{sessionId:'native-live'})).runs[0]);
 report.checks.registryAccess=!!(await rpc.call('capabilities')).active;
 report.checks.experimentAccess=Array.isArray(await rpc.call('experiments'));
 report.checks.contractValidation=(await rpc.call('contract',{file:path.join(workspace,'ui-contract.json')})).valid;
 report.passed=Object.values(report.checks).every(Boolean);assert(report.passed);
} catch { report.error='packaged_bridge_live_verification_failed';process.exitCode=1; }
finally {
 if(rpc)await rpc.close();
 report.requests=(await fs.readFile(audit,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).length;
 report.requestCeiling=18;
 await fs.rm(workspace,{recursive:true,force:true});
 report.workspaceCleaned=true;
 await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({passed:report.passed,checks:report.checks,requests:report.requests,sourceRevision:report.sourceRevision,uiWorkspace:report.uiWorkspaceRetained?workspace:undefined,error:report.error},null,2));
}
