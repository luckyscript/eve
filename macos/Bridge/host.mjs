import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, redactConfig, redact, validateConfig, DEFAULTS } from '../../src/config.mjs';
import { listSessions, loadSession, runSession, compactSession, sessionStatus } from '../../src/sessions.mjs';
import { discoverSkills } from '../../src/skills.mjs';
import { TOOL_SCHEMAS } from '../../src/tools.mjs';
import { capabilities, importBaseline, promote, rollback, privateDirectory, readPrivate, atomicPrivate } from '../../src/registry.mjs';
import { loadContract } from '../../src/contracts.mjs';
import { evolve, autoEvolve, freezeSuite } from '../../src/evolution.mjs';
import { protectLocalConfig } from './local-config.mjs';
import { prepareAutoEvolution } from '../../src/orchestration.mjs';
const fields = {
 workspace:['path'], busy:[], cancel:['requestID'], config:[], configure:['values'], secret:['value'], sessions:[], session:['sessionId'], status:['sessionId'], tools:[], skills:[], capabilities:[], experiments:[],
 run:['prompt','sessionId','contractFile','autoEvolve','skill','suiteFile','correction','maxRequests','timeoutMs','autoPromote'], compact:['sessionId'], contract:['file'], suite:['file'], import:['file'], promote:['id'], rollback:['name'], evolve:['sessionId','runId','skill','suiteFile','correction','maxRequests','timeoutMs','autoPromote']
};
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
export const eventProjection = e => pick(e,['type','at','name','step','request','ok','status','callId','skill','hash','finishReason','toolCount','verificationStatus','modelStatus']);
const verification = v => v && {status:v.status,assertions:(v.assertions||[]).map(a=>pick(a,['index','type','path','passed','reason']))};
const candidate = c => pick(c,['id','name','hash','parent','status','evaluationHash','experimentId','trustedBaseline']);
export function evolutionProjection(r) { return {...pick(r,['status','experimentId','evaluationHash','budget','actualActiveHash','recording_error','nextTaskOnly']), candidate:r.candidate&&candidate(r.candidate), evaluation:r.evaluation&&{status:r.evaluation.status,cases:r.evaluation.cases.map(c=>({id:c.id,baseline:pick(c.baseline,['passed','certain','status']),candidate:pick(c.candidate,['passed','certain','status'])}))}, error:r.error}; }
export function runProjection(r) { return {...pick(r,['id','runId','sessionId','prompt','status','modelStatus','final','stats','startedAt','endedAt']),error:r.error&&pick(r.error,['code','message']),verification:verification(r.verification),events:(r.events||[]).map(eventProjection),evolution:r.evolution&&evolutionProjection(r.evolution)}; }
export class BridgeHost {
 constructor({fetchImpl=fetch,onEvent=()=>{}}={}) { this.fetchImpl=fetchImpl; this.onEvent=onEvent; this.controllers=new Map(); this.cwd=null; this.active=null; this.config=null; }
 safe(value) {
  if(typeof value==='string') return redact(value,this.config);
  if(Array.isArray(value)) return value.map(v=>this.safe(v));
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[redact(k,this.config),this.safe(v)]));
  return value ?? null;
 }
 async call(op,p={},requestID='direct') {
  if (!Object.hasOwn(fields,op) || !p || typeof p!=='object' || Array.isArray(p) || Object.keys(p).some(k=>!fields[op].includes(k))) throw new Error('未知 operation 或参数');
  for (const [k,v] of Object.entries(p)) {
   if (['maxRequests','timeoutMs'].includes(k)) { if(!Number.isInteger(v)||v<1||v>(k==='maxRequests'?100:1800000)) throw new Error('预算无效'); }
   else if (['autoEvolve','autoPromote'].includes(k)) { if(typeof v!=='boolean') throw new Error('开关无效'); }
   else if(k!=='values' && (typeof v!=='string'||v.length>(['prompt','correction'].includes(k)?16000:4096)||(k!=='correction'&&!v.trim()))) throw new Error('字符串参数无效');
  }
  if(op==='busy') return {busy:!!this.active,requestID:this.active,workspace:this.cwd};
  if(op==='cancel') { this.controllers.get(p.requestID)?.abort(); return {requested:this.controllers.has(p.requestID),writesReverted:false}; }
  // Reads involving sessions may recover interrupted ledgers: serialize with writes as well.
  if(this.active) throw new Error('workspace busy; wait for active operation to settle');
  this.active=requestID; const controller=new AbortController(); this.controllers.set(requestID,controller);
  try {
   if(op==='workspace') { const root=await fs.realpath(p.path); if(!(await fs.stat(root)).isDirectory()) throw new Error('workspace 必须为目录'); const config=await loadConfig({cwd:root}); this.cwd=root; this.config=config; return {path:root}; }
   if(!this.cwd) throw new Error('请先选择 workspace');
   const cwd=this.cwd, config=this.config=await loadConfig({cwd}), signal=controller.signal;
   const options={cwd,config,signal,fetchImpl:this.fetchImpl,onEvent:e=>this.onEvent(requestID,this.safe(eventProjection(e)))};
   let result;
   switch(op) {
    case 'config': result=redactConfig(config); break;
    case 'configure': case 'secret': {
     const values=op==='secret'?{apiKey:p.value}:p.values;
     if(!values||typeof values!=='object'||Array.isArray(values)|| (op==='configure'&&Object.hasOwn(values,'apiKey'))) throw new Error('配置参数无效，密钥使用专用操作');
     validateConfig({...config,...values});
     await privateDirectory(cwd,[]); // checks private directories against symlinks
     await protectLocalConfig(cwd);
     const file=path.join(cwd,'.eve','config.local.json'); let old={};
     try { const st=await fs.lstat(file); if(st.isSymbolicLink()||!st.isFile()) throw new Error('本地配置路径无效'); old=JSON.parse(await fs.readFile(file,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; }
     validateConfig({...old,...values}); await atomicPrivate(file,{...old,...values}); await fs.chmod(file,0o600);
     this.config=await loadConfig({cwd}); result={saved:true,config:redactConfig(this.config)}; break;
    }
    case 'sessions': result=await listSessions(cwd); break;
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
     const r=await runSession({...options,...pick(p,['prompt','sessionId','contractFile'])});
     if(p.autoEvolve) { try {r.evolution=await autoEvolve({...options,...pick(p,['skill','suiteFile','correction','maxRequests','timeoutMs','autoPromote']),result:r,frozenSuite});} catch {r.evolution={status:'failed',error:'进化失败，查看实验记录',nextTaskOnly:true};} }
     result={...runProjection(r),context:await sessionStatus(cwd,r.sessionId,config)}; break;
    }
    case 'evolve': result=evolutionProjection(await evolve({...options,...p})); break;
   }
   return this.safe(result);
  } finally { this.controllers.delete(requestID); this.active=null; }
 }
}
