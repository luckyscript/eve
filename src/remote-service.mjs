import { randomUUID } from 'node:crypto';
import { loadConfig, redact } from './config.mjs';
import { runSession, loadSession, listSessions, compactSession, sessionStatus, validateSessionId } from './sessions.mjs';
import { discoverSkills } from './skills.mjs';
import { capabilities } from './registry.mjs';
const pick=(o,ks)=>Object.fromEntries(ks.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
const fields={'desktop.info':[],'sessions.list':[],'sessions.get':['sessionId'],'run.start':['sessionId','prompt','contractName'],'run.cancel':['requestId'],'run.lookup':['requestId'],'skills.list':[],'capabilities.list':[],'context.status':['sessionId'],'context.compact':['sessionId']};
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const failure={code:'OPERATION',message:'Operation denied or failed; inspect local state.'};
export class RemoteService {
 constructor(store,{fetchImpl=fetch,localBusy=()=>false}={}){this.store=store;this.cwd=store.cwd;this.fetchImpl=fetchImpl;this.localBusy=localBusy;this.queue=Promise.resolve();this.running=new Map();this.pending=new Set();this.stopping=false;this.active=false;}
 serial(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
 async safe(value){const config=await loadConfig({cwd:this.cwd});const settings=await this.store.settings(), pairs=await this.store.pairs();const secrets=[config.apiKey,settings.registrationKey,...pairs.flatMap(p=>[p.secret,p.routingToken])].filter(Boolean);return JSON.parse(JSON.stringify(value,(_k,v)=>{if(typeof v!=='string')return v;let s=redact(v,config);for(const x of secrets)s=s.split(x).join('[redacted]');return s.replace(/(?:https?|wss?):\/\/[^\s"<>]*\/c\/[^\s"<>]+/g,'[redacted relay URL]');}));}
 async request(pairId,q,emit=()=>{}){
  let id=q?.id;
  try{
   if(this.stopping||!q||q.kind!=='request'||!uuid(id)||!Object.hasOwn(fields,q.op)||Object.keys(q).some(k=>!['kind','id','op','params'].includes(k)))throw new Error();
   const p=q.params;if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!fields[q.op].includes(k)))throw new Error();
   for(const [k,v]of Object.entries(p))if(typeof v!=='string'||!v.trim()||v.length>(k==='prompt'?16000:128)||/[\x00]/.test(v))throw new Error();
   if(p.sessionId)validateSessionId(p.sessionId);
   if(p.requestId&&!uuid(p.requestId))throw new Error();
   if(['sessions.get','context.status','context.compact'].includes(q.op)&&!p.sessionId)throw new Error();
   if(['run.lookup','run.cancel'].includes(q.op)&&!p.requestId)throw new Error();
   const pair=(await this.store.pairs()).find(x=>x.pairId===pairId);if(!pair?.clientId)throw new Error();
   let result;
   if(q.op==='run.lookup')result=await this.store.lookup(pairId,p.requestId);
   else if(q.op==='run.cancel') {await this.store.lookup(pairId,p.requestId);const r=this.running.get(p.requestId);if(r?.pairId===pairId)r.controller.abort();result={requested:r?.pairId===pairId};}
   else if(['run.start','context.compact'].includes(q.op)){
    if(q.op==='run.start'&&!p.prompt)throw new Error();
    const b=await this.store.begin(pairId,id,q.op,p);
    if(!b.fresh){result=await this.store.lookup(pairId,id);if(result.state==='completed')result=result.result;}
    else{
     const controller=new AbortController();this.running.set(id,{pairId,controller});
     result=await this.serial(async()=>{
      try{if(this.stopping||this.localBusy()||controller.signal.aborted)throw new Error();
       const settings=await this.store.settings();if(!settings.enabled||!(await this.store.pairs()).some(x=>x.pairId===pairId))throw new Error();
       this.active=true;const config=await loadConfig({cwd:this.cwd}),sessionId=p.sessionId||`s-${randomUUID()}`;
       await this.store.ownSession(pairId,sessionId,!p.sessionId);
       let contractFile;if(p.contractName){if(!Object.hasOwn(settings.contracts,p.contractName))throw new Error();contractFile=settings.contracts[p.contractName];}
       if(q.op==='context.compact'&&!settings.allowCompact)throw new Error();
       const options={cwd:this.cwd,config,sessionId,signal:controller.signal,fetchImpl:this.fetchImpl,onEvent:e=>{
        // The core emits synchronously before executing a tool; fail closed for any future tool too.
        if(e.type==='tool_intent'&&!['list_files','read_file','search_files','load_skill',...(settings.allowWrite?['write_file','edit_file']:[])].includes(e.name))throw new Error('Remote tool permission denied');
        const event=pick(e,['type','name','step','request','ok','status','skill','hash','finishReason','toolCount','verificationStatus','modelStatus']);emit({kind:'event',requestId:id,event});
       }};
       const raw=q.op==='run.start'?await runSession({...options,prompt:p.prompt,contractFile}):await compactSession(options);
       const out=await this.safe(this.runProjection(raw));await this.store.finish(pairId,id,out);return out;
      }catch{await this.store.finish(pairId,id,null,failure);throw new Error();}
      finally{this.active=false;this.running.delete(id);}
     });
    }
   }else result=await this.serial(async()=>{
    if(this.localBusy())throw new Error();const settings=await this.store.settings(),config=await loadConfig({cwd:this.cwd});
    if(p.sessionId)await this.store.ownSession(pairId,p.sessionId);
    switch(q.op){
     case 'desktop.info':return {name:settings.desktopName,workspace:this.cwd,protocol:1,permissions:{allowWrite:settings.allowWrite,allowCompact:settings.allowCompact,contracts:Object.keys(settings.contracts)},busy:this.active};
     case 'sessions.list':{const ids=new Set(await this.store.sessionIds(pairId));const visible=(await listSessions(this.cwd)).filter(s=>ids.has(s.id)).slice(-200);return {sessions:await Promise.all(visible.map(async s=>{const session=await loadSession(this.cwd,s.id);const title=String(session.runs.find(r=>r.prompt)?.prompt||'Eve session').replace(/\s+/g,' ').trim().slice(0,64);return {id:s.id,title,status:s.status,updatedAt:s.updatedAt,runCount:s.runs||0};}))};}
     case 'sessions.get':{const s=await loadSession(this.cwd,p.sessionId);return {id:s.id,runs:s.runs.slice(-20).map(r=>this.runProjection(r)),truncated:s.runs.length>20};}
     case 'context.status':return sessionStatus(this.cwd,p.sessionId,config);
     case 'skills.list':{const d=await discoverSkills(this.cwd,config);return {skills:[...d.skills.values()].map(s=>pick(s,['name','description','hash'])),warnings:d.warnings.length?['Local skill discovery warnings; inspect on desktop.']:[]};}
     case 'capabilities.list':{const c=await capabilities(this.cwd);return {revision:c.revision,active:c.active,candidates:Object.values(c.candidates).map(x=>pick(x,['id','name','hash','parent','status']))};}
    }
   });
   return {kind:'response',id,ok:true,result:await this.safe(result)};
  }catch{return {kind:'response',id:uuid(id)?id:null,ok:false,error:failure};}
 }
 runProjection(r){const out=pick(r,['id','sessionId','runId','status','modelStatus','stats']);for(const k of ['prompt','final'])if(typeof r[k]==='string'){out[k]=r[k].slice(0,8000);if(r[k].length>8000)out.truncated=true;}if(r.verification)out.verification={status:r.verification.status,assertions:(r.verification.assertions||[]).map(a=>pick(a,['index','type','passed']))};return out;}
 cancelPair(pairId){for(const r of this.running.values())if(r.pairId===pairId)r.controller.abort();}
 async stop(){this.stopping=true;for(const r of this.running.values())r.controller.abort();await this.queue;}
}
