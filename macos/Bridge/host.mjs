import { createRemoteOperations, remoteFields } from './remote-host.mjs';
import { withAbort } from '../../src/agent.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, redactConfig, redact, validateConfig, DEFAULTS, inspectConfig } from '../../src/config.mjs';
import { listSessions, loadSession, runSession, compactSession, sessionStatus, updateSession, deleteSession } from '../../src/sessions.mjs';
import { discoverSkills } from '../../src/skills.mjs';
import { TOOL_SCHEMAS } from '../../src/tools.mjs';
import { capabilities, importBaseline, promote, rollback, privateDirectory, readPrivate, atomicPrivate } from '../../src/registry.mjs';
import { loadContract } from '../../src/contracts.mjs';
import { evolve, autoEvolve, freezeSuite } from '../../src/evolution.mjs';
import { protectLocalConfig } from './local-config.mjs';
import { prepareAutoEvolution } from '../../src/orchestration.mjs';
const fields = {
 ...remoteFields,
 workspace:['path'], busy:[], cancel:['requestID'], config:[], configure:['values'], secret:['value'], 'config.inspect':[], 'config.repair':['values','confirm'], 'connection.test':[], sessions:['query','includeArchived'], 'session.page':['sessionId','cursor','limit'], 'session.rename':['sessionId','title'], 'session.archive':['sessionId','archived'], 'session.delete':['sessionId','confirm'], session:['sessionId'], status:['sessionId'], tools:[], skills:[], capabilities:[], experiments:[],
 run:['stream','prompt','sessionId','contractFile','autoEvolve','skill','suiteFile','correction','maxRequests','timeoutMs','autoPromote'], compact:['sessionId'], contract:['file'], suite:['file'], import:['file'], promote:['id'], rollback:['name'], evolve:['sessionId','runId','skill','suiteFile','correction','maxRequests','timeoutMs','autoPromote']
};
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
export const eventProjection = e => pick(e,['type','at','name','step','request','ok','status','callId','skill','hash','finishReason','toolCount','verificationStatus','modelStatus','text']);
const verification = v => v && {status:v.status,assertions:(v.assertions||[]).map(a=>pick(a,['index','type','path','passed','reason']))};
const candidate = c => pick(c,['id','name','hash','parent','status','evaluationHash','experimentId','trustedBaseline']);
export function evolutionProjection(r) { return {...pick(r,['status','experimentId','evaluationHash','budget','actualActiveHash','recording_error','nextTaskOnly']), candidate:r.candidate&&candidate(r.candidate), evaluation:r.evaluation&&{status:r.evaluation.status,cases:r.evaluation.cases.map(c=>({id:c.id,baseline:pick(c.baseline,['passed','certain','status']),candidate:pick(c.candidate,['passed','certain','status'])}))}, error:r.error}; }
export function runProjection(r) { return {...pick(r,['id','runId','sessionId','prompt','status','modelStatus','final','stats','startedAt','endedAt']),error:r.error&&(r.error.code==='HTTP'&&/HTTP 401\b/.test(r.error.message)?{code:'HTTP401',message:'模型接口返回 HTTP 401，请检查 API 密钥和访问权限'}:pick(r.error,['code','message'])),verification:verification(r.verification),events:(r.events||[]).map(eventProjection),evolution:r.evolution&&evolutionProjection(r.evolution)}; }
export class BridgeHost {
 constructor({fetchImpl=fetch,onEvent=()=>{}}={}) { this.fetchImpl=fetchImpl; this.onEvent=onEvent; this.controllers=new Map(); this.cwd=null; this.active=null; this.config=null; this.remote=createRemoteOperations({getWorkspace:()=>this.cwd,isLocalBusy:()=>!!this.active}); }
 safe(value, config=this.config) {
  if(typeof value==='string') return redact(value,config);
  if(Array.isArray(value)) return value.map(v=>this.safe(v,config));
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[redact(k,config),this.safe(v,config)]));
  return value ?? null;
 }
 async shutdown(){this.controllers.forEach(c=>c.abort());await this.remote.shutdown();}
 async testConnection(config,signal){
  const start=Date.now(),timeout=AbortSignal.timeout(10000),combined=AbortSignal.any([signal,timeout]);
  try{
   return await withAbort((async()=>{
   const response=await this.fetchImpl(config.baseUrl+'/models',{signal:combined,headers:config.apiKey?{Authorization:`Bearer ${config.apiKey}`}:{}});
   if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`模型列表接口返回 HTTP ${response.status}；请检查服务是否提供 /models 以及凭据权限`),{code:response.status===401?'HTTP401':'HTTP',status:response.status});}
   const reader=response.body.getReader();let bytes=0,chunks=[];try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>262144)throw Object.assign(new Error('模型列表超过响应限额'),{code:'LIMIT'});chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
   let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('模型列表不是有效 JSON'),{code:'PROTOCOL'});}
   if(!Array.isArray(data.data))throw Object.assign(new Error('模型列表缺少 data 数组'),{code:'PROTOCOL'});
   return {ok:true,models:data.data.filter(m=>m&&typeof m.id==='string'&&m.id.length<=4096).slice(0,1000).map(m=>({id:m.id})),latencyMs:Date.now()-start};
   })(),combined);
  }catch(e){return {ok:false,models:[],error:timeout.aborted?{code:'TIMEOUT',message:'连接测试超过 10 秒，请检查网络和服务地址'}:signal.aborted?{code:'CANCELLED',message:'连接测试已取消'}:bridgeError(e),latencyMs:Date.now()-start};}
 }
 async call(op,p={},requestID='direct') {
  if(op.startsWith('remote.')) {if(!this.remote)throw new Error('远程宿主尚不可用');return bounded(await this.remote.call(op,p));}
  if (!Object.hasOwn(fields,op) || !p || typeof p!=='object' || Array.isArray(p) || Object.keys(p).some(k=>!fields[op].includes(k))) throw new Error('未知 operation 或参数');
  for (const [k,v] of Object.entries(p)) {
   if(k==='limit') {if(!Number.isInteger(v)||v<1||v>100)throw new Error('分页 limit 必须为 1–100');}
   else if (['maxRequests','timeoutMs'].includes(k)) { if(!Number.isInteger(v)||v<1||v>(k==='maxRequests'?100:1800000)) throw new Error('预算无效'); }
   else if (['autoEvolve','autoPromote','stream','confirm','archived','includeArchived'].includes(k)) { if(typeof v!=='boolean') throw new Error('开关无效'); }
   else if(k!=='values' && (typeof v!=='string'||v.length>(['prompt','correction'].includes(k)?16000:4096)||(k!=='correction'&&!v.trim()))) throw new Error('字符串参数无效');
  }
  if(op==='busy') return {busy:!!this.active,requestID:this.active,workspace:this.cwd};
  if(op==='cancel') { this.controllers.get(p.requestID)?.abort(); return {requested:this.controllers.has(p.requestID),writesReverted:false}; }
  // Each ledger has its own recovery lock. Browsing another session must not
  // seize the running task's ownership or make that task uncancellable.
  const concurrentRead = this.activeOperation==='run' && ['session','session.page','status'].includes(op) && p.sessionId!==this.activeSessionId;
  if((this.active && !concurrentRead) || (['run','compact','evolve'].includes(op)&&this.remote?.isRemoteBusy())) throw new Error('workspace busy; wait for active operation to settle');
  const ownsActive=!this.active;
  if(ownsActive){this.active=requestID;this.activeOperation=op;this.activeSessionId=p.sessionId;}
  const controller=new AbortController(); this.controllers.set(requestID,controller);
  try {
   if(op==='workspace') {
    const root=await fs.realpath(p.path);if(!(await fs.stat(root)).isDirectory())throw new Error('workspace 必须为目录');
    await this.remote?.beforeWorkspaceSwitch();this.cwd=root;
    const inspected=await inspectConfig({cwd:root});this.config=inspected.config;
    return {path:root,...(!inspected.valid?{configurationError:{code:'CONFIG',message:'配置无效，请在设置中检查并修复',diagnostics:inspected.diagnostics}}:{})};
   }
   if(!this.cwd) throw new Error('请先选择 workspace');
   const cwd=this.cwd, inspected=await inspectConfig({cwd}), signal=controller.signal;
   const config=inspected.config;
   if(ownsActive)this.config=config;
   if(!['config.inspect','configure','secret','config.repair','tools','sessions','session','session.page','session.rename','session.archive','session.delete'].includes(op)&&!inspected.valid)throw Object.assign(new Error('配置无效；请打开设置检查并修复'),{code:'CONFIG'});
   const options={cwd,config,signal,fetchImpl:this.fetchImpl,onEvent:e=>this.onEvent(requestID,this.safe(eventProjection(e),config))};
   let result;
   switch(op) {
    case 'config': result=redactConfig(config); break;
    case 'config.inspect': return {...inspected,config:redactConfig(config)};
    case 'connection.test': return await this.testConnection(config,signal);
    case 'config.repair':

    case 'configure': case 'secret': {
     const values=op==='secret'?{apiKey:p.value}:p.values;
     if(op==='config.repair'&&p.confirm!==true)throw new Error('修复需要 confirm:true');
     if(!values||typeof values!=='object'||Array.isArray(values)|| (op!=='secret'&&Object.hasOwn(values,'apiKey'))) throw new Error('配置参数无效，密钥使用专用操作');
     validateConfig({...config,...values});
     const file=path.join(cwd,'.eve','config.local.json');
     if(op==='config.repair'&&inspected.diagnostics.some(d=>d.path!==file))throw Object.assign(new Error('请先修复全局、共享或环境配置；本操作仅修复本地私有配置'),{code:'CONFIG'});

     await privateDirectory(cwd,[]); // checks private directories against symlinks
     await protectLocalConfig(cwd);
     let old={},raw;
     try { const st=await fs.lstat(file); if(st.isSymbolicLink()||!st.isFile()) throw new Error('本地配置路径无效'); raw=await fs.readFile(file,'utf8');try{old=JSON.parse(raw);if(!old||typeof old!=='object'||Array.isArray(old)){if(op==='config.repair')old={};else throw new Error('invalid config shape');}}catch{if(op!=='config.repair')throw Object.assign(new Error('本地 JSON 无效；请使用配置修复'),{code:'CONFIG'});} } catch(e) { if(e.code!=='ENOENT') throw e; }
     validateConfig({...old,...values});
     if(op==='config.repair'&&raw!==undefined) {
      await protectRepairBackups(cwd);
      const dir=await privateDirectory(cwd,['config-backups']);
      const handle=await fs.open(path.join(dir,`config-${Date.now()}-${crypto.randomUUID()}.json`),'wx',0o600);try{await handle.writeFile(raw);await handle.sync();}finally{await handle.close();}
      const directory=await fs.open(dir,'r');try{await directory.sync();}finally{await directory.close();}
     }
     await atomicPrivate(file,{...old,...values}); await fs.chmod(file,0o600);
     this.config=await loadConfig({cwd}); result={saved:true,config:redactConfig(this.config)}; break;
    }
    case 'sessions': result=await listSessions(cwd,p); break;
    case 'session.rename': if(typeof p.title!=='string'||p.title.length>160)throw new Error('标题必须为 1–160 字符');result=await updateSession(cwd,p.sessionId,{title:p.title});break;
    case 'session.archive': if(typeof p.archived!=='boolean')throw new Error('archived 必须为布尔值');result=await updateSession(cwd,p.sessionId,{archived:p.archived});break;
    case 'session.delete': if(p.confirm!==true)throw new Error('删除需要 confirm:true');result=await deleteSession(cwd,p.sessionId);break;
    case 'session.page': return bounded(await sessionPage(cwd,p,value=>this.safe(value)));
    case 'session': { const d=await loadSession(cwd,p.sessionId); result={id:d.id,runs:d.runs.map(runProjection)}; break; }
    case 'status': result=await sessionStatus(cwd,p.sessionId,config); break;
    case 'tools': result=TOOL_SCHEMAS; break;
    case 'skills': { const d=await discoverSkills(cwd,config); result={skills:[...d.skills.values()].map(s=>pick(s,['name','description','hash','published'])),warnings:d.warnings}; break; }
    case 'capabilities': { const c=await capabilities(cwd); result={revision:c.revision,active:c.active,candidates:Object.values(c.candidates).map(candidate)}; break; }
    case 'experiments': {
     const dir=await privateDirectory(cwd,['experiments']); result=[];
     for(const id of (await fs.readdir(dir)).filter(x=>/^e-[a-f0-9-]+$/.test(x))) { try { const r=await readPrivate(path.join(dir,id,'experiment.json')); result.push({...evolutionProjection({...r,experimentId:r.id,evaluation:{status:r.status,cases:r.cases}}),source:r.source}); } catch { result.push({experimentId:id,status:'unreadable'}); } } break;
    }
    case 'contract': { const c=await loadContract(cwd,p.file); result={valid:true,assertions:c.assertions.length}; break; }
    case 'suite': { const f=await freezeSuite(cwd,p.file); result={valid:true,hash:f.suiteHash,cases:f.suite.cases.length,requestCeiling:1+2*f.suite.cases.length*f.suite.budget.maxSteps}; break; }
    case 'import': result=candidate(await importBaseline(cwd,p.file)); break;
    case 'promote': result=candidate(await promote(cwd,p.id,{signal})); break;
    case 'rollback': result=await rollback(cwd,p.name); break;
    case 'compact': { const r=await compactSession({...options,sessionId:p.sessionId}); result={...runProjection(r),context:await sessionStatus(cwd,p.sessionId,config)}; break; }
    case 'run': {
     if(!p.prompt) throw new Error('需要任务文本');
     const frozenSuite=p.autoEvolve?await prepareAutoEvolution({cwd,...p}):undefined;
     const r=await runSession({...options,...pick(p,['prompt','sessionId','contractFile','stream'])});
     if(p.autoEvolve) { try {r.evolution=await autoEvolve({...options,...pick(p,['skill','suiteFile','correction','maxRequests','timeoutMs','autoPromote']),result:r,frozenSuite});} catch {r.evolution={status:'failed',error:'进化失败，查看实验记录',nextTaskOnly:true};} }
     result={...runProjection(r),context:await sessionStatus(cwd,r.sessionId,config)}; break;
    }
    case 'evolve': result=evolutionProjection(await evolve({...options,...p})); break;
   }
   if(['config','configure','secret','config.repair'].includes(op))return bounded(result);
   return bounded(this.safe(result,config));
  } finally {
   this.controllers.delete(requestID);
   if(ownsActive&&this.active===requestID){this.active=null;this.activeOperation=null;this.activeSessionId=null;}
  }
 }
}

export const OUTPUT_LIMIT=512*1024-4096;
export function bounded(value){if(Buffer.byteLength(JSON.stringify(value))>OUTPUT_LIMIT)throw Object.assign(new Error('响应超过字节限额；请使用 session.page 分页读取'),{code:'LIMIT'});return value;}
export function bridgeError(e){
 if(/^REMOTE_[A-Z_]+$/.test(e?.code||''))return {code:e.code,message:e.message};
 const text=String(e?.message||'');const code=e?.code==='HTTP401'||(e?.code==='HTTP'&&/HTTP 401\b/.test(text))?'HTTP401':e?.code==='TimeoutError'?'TIMEOUT':['LIMIT','HTTP','TIMEOUT','CANCELLED','PROTOCOL','CONFIG'].includes(e?.code)?e.code:/lock|锁|busy|占用/i.test(text)?'LOCK':/budget|预算/i.test(text)?'BUDGET':/config|配置/i.test(text)?'CONFIG':'VALIDATION';
 const messages={LOCK:'工作区或会话正被占用，请等待当前操作结束后重试',BUDGET:'预算无效或已耗尽，请检查设置中的运行预算',CONFIG:'配置无效，请打开设置检查并修复配置文件',VALIDATION:'参数或路径无效，请检查输入和所选工作区',HTTP401:'模型接口返回 HTTP 401，请检查 API 密钥和访问权限',TIMEOUT:'请求超时，请检查服务和网络后重试',CANCELLED:'操作已取消，请检查已写入产物',LIMIT:'响应超过字节限额，请使用 session.page 分页读取',HTTP:'服务返回 HTTP 错误，请检查接口地址和权限',PROTOCOL:'服务响应格式无效，请检查兼容接口'};
 return {code,message:code==='HTTP'&&Number.isInteger(e.status)?`模型接口返回 HTTP ${e.status}；请检查服务是否提供该接口及访问权限`:messages[code]};
}
async function protectRepairBackups(cwd){
 // Enforce an ending ignore rule even in independently initialized workspaces.
 const file=path.join(cwd,'.gitignore');const h=await fs.open(file,'a');try{await h.writeFile('/.eve/evolution/config-backups/\n');await h.sync();}finally{await h.close();}
}
async function sessionPage(cwd,{sessionId,cursor,limit=20},safe=value=>value){
 const data=await loadSession(cwd,sessionId);let end=cursor===undefined?data.runs.length:Number(cursor);
 if(cursor!==undefined&&!/^(0|[1-9][0-9]*)$/.test(cursor)||!Number.isSafeInteger(end)||end<0||end>data.runs.length)throw new Error('分页 cursor 无效');
 let start=end,runs=[],truncated=false;
 while(start>0&&runs.length<limit){let run=safe(runProjection(data.runs[start-1]));if(Buffer.byteLength(JSON.stringify(run))>OUTPUT_LIMIT-2048){run={...pick(run,['id','runId','status','startedAt','endedAt']),truncated:true,error:{code:'LIMIT',message:'该运行超过显示限额；完整证据保存在本地会话账本'}};truncated=true;}
 const next=[run,...runs];if(Buffer.byteLength(JSON.stringify(next))>OUTPUT_LIMIT-2048)break;runs=next;start--;}
 return {id:safe(data.id),runs,nextCursor:start>0?String(start):null,hasMore:start>0,total:data.runs.length,...(truncated?{truncated:true}:{})};
}
