import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { atomicPrivate, readPrivate } from './registry.mjs';
import { hash, relayURL } from './remote-crypto.mjs';
const fresh=()=>({v:1,settings:{enabled:false,relayUrl:'',desktopName:os.hostname().slice(0,80),development:false,allowWrite:false,allowCompact:false,contracts:{}},pairs:{},ledger:{},sessions:{}});
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return true;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
export function canonical(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;}
export class RemoteStore {
 static async open(cwd){
  const root=await fs.realpath(cwd);let dir=root;
  for(const part of ['.eve','remote']){dir=path.join(dir,part);await fs.mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const st=await fs.lstat(dir);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Unsafe remote directory');await fs.chmod(dir,0o700);}
  const s=new RemoteStore(root,dir);await s.tx(()=>{});return s;
 }
 constructor(cwd,dir){this.cwd=cwd;this.dir=dir;this.tail=Promise.resolve();}
 async lock(name){
  const file=path.join(this.dir,name),temp=`${file}.${randomUUID()}.tmp`,token=randomUUID();
  await fs.mkdir(temp,{mode:0o700});await atomicPrivate(path.join(temp,'owner.json'),{pid:process.pid,token});
  try{
   for(let n=0;n<2;n++){
    try{await fs.rename(temp,file);return async()=>{const owner=await readPrivate(path.join(file,'owner.json'));if(owner.token!==token)throw new Error('Remote lock changed');await fs.rm(file,{recursive:true});};}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code))throw e;}
    const st=await fs.lstat(file);if(st.isSymbolicLink()||!st.isDirectory())throw new Error('Unsafe remote lock');
    const reap=`${file}.reap`;await fs.mkdir(reap,{mode:0o700}).catch(()=>{throw new Error('Remote lock busy');});
    try{const owner=await readPrivate(path.join(file,'owner.json'));if(alive(owner.pid))throw new Error('Remote writer already running');await fs.rm(file,{recursive:true});}finally{await fs.rmdir(reap);}
   }
   throw new Error('Remote lock busy');
  }finally{await fs.rm(temp,{force:true,recursive:true});}
 }
 tx(fn){const task=this.tail.then(async()=>{const release=await this.lock('state.lock');try{let s;try{s=await readPrivate(path.join(this.dir,'state.json'));}catch(e){if(e.code!=='ENOENT')throw e;s=fresh();}if(s.v!==1)throw new Error('Invalid remote store');const r=await fn(s);await atomicPrivate(path.join(this.dir,'state.json'),s);return structuredClone(r);}finally{await release();}});this.tail=task.catch(()=>{});return task;}
 settings(){return this.tx(s=>s.settings);}
 configure(p){return this.tx(s=>{
  const allowed=['enabled','relayUrl','desktopName','development','allowWrite','allowCompact','registrationKey','contracts'];
  if(!p||Object.keys(p).some(k=>!allowed.includes(k)))throw new Error('Invalid remote settings');
  const next={...s.settings,...p};
  for(const k of ['enabled','development','allowWrite','allowCompact'])if(typeof next[k]!=='boolean')throw new Error('Invalid permission');
  if(typeof next.desktopName!=='string'||!next.desktopName.trim()||next.desktopName.length>80||/[\x00-\x1f]/.test(next.desktopName))throw new Error('Invalid desktop name');
  if(next.relayUrl)next.relayUrl=relayURL(next.relayUrl,next.development);
  if(next.enabled&&!next.relayUrl)throw new Error('Relay URL required');
  if(next.registrationKey!==undefined&&(typeof next.registrationKey!=='string'||next.registrationKey.length>4096))throw new Error('Invalid registration key');
  if(!next.contracts||typeof next.contracts!=='object'||Array.isArray(next.contracts)||Object.entries(next.contracts).some(([k,v])=>!/^[A-Za-z0-9_-]{1,64}$/.test(k)||typeof v!=='string'||v.length>4096))throw new Error('Invalid contract allowlist');
  s.settings=next;return this.project(s);
 });}
 project(s){const {registrationKey,...settings}=s.settings;return {settings:{...settings,registrationConfigured:!!registrationKey},pairs:Object.values(s.pairs).map(p=>({pairId:p.pairId,createdAt:p.createdAt,expiresAt:p.expiresAt,clientId:p.clientId,clientName:p.clientName,revoked:!!p.revoked,bound:!!p.clientId}))};}
 status(){return this.tx(s=>this.project(s));}
 invite(){return this.tx(s=>{const p={v:1,pairId:randomUUID(),secret:randomBytes(32).toString('base64url'),routingToken:randomBytes(32).toString('base64url'),expiresAt:Date.now()+600000,createdAt:Date.now()};s.pairs[p.pairId]=p;return {...p,relayUrl:s.settings.relayUrl,desktopName:s.settings.desktopName};});}
 pairs(){return this.tx(s=>Object.values(s.pairs).filter(p=>!p.revoked&&(p.clientId||p.expiresAt>Date.now())));}
 bind(id,clientId,now=Date.now(),clientName='Android'){return this.tx(s=>{const p=s.pairs[id];if(!p||p.revoked||p.clientId&&p.clientId!==clientId||!p.clientId&&now>p.expiresAt)throw new Error('Pair denied');p.clientId=clientId;p.clientName=clientName;return p;});}
 revoke(id){return this.tx(s=>{if(!s.pairs[id])throw new Error('Pair not found');s.pairs[id].revoked=true;return {revoked:true};});}
 recover(){return this.tx(s=>{for(const r of Object.values(s.ledger))if(r.state==='running'){r.state='unknown';r.error={code:'INTERRUPTED',message:'Interrupted; inspect session and output. Never replayed.'};}});}
 begin(pairId,id,op,params){return this.tx(s=>{const digest=hash(canonical({op,params}));const old=s.ledger[id];if(old){if(old.pairId!==pairId||old.digest!==digest)throw new Error('Request conflict');return {fresh:false,record:old};}if(Object.keys(s.ledger).length>=10000)throw new Error('Request ledger capacity reached');const record={pairId,id,op,digest,state:'running',createdAt:Date.now()};s.ledger[id]=record;return {fresh:true,record};});}
 finish(pairId,id,result,error){return this.tx(s=>{const r=s.ledger[id];if(!r||r.pairId!==pairId)throw new Error('Request denied');Object.assign(r,error?{state:'failed',error}:{state:'completed',result});});}
 lookup(pairId,id){return this.tx(s=>{const r=s.ledger[id];if(r&&r.pairId!==pairId)throw new Error('Request denied');if(!r)return {state:'unknown'};return {state:r.state,...(r.result?{result:r.result}:{}),...(r.error?{error:r.error}:{})};});}
 ownSession(pairId,id,create=false){return this.tx(s=>{const owner=s.sessions[id];if(owner!==pairId){if(owner||!create)throw new Error('Session denied');s.sessions[id]=pairId;}return true;});}
 sessionIds(pairId){return this.tx(s=>Object.keys(s.sessions).filter(id=>s.sessions[id]===pairId));}
}
export function inviteURI(p){const {v,relayUrl,routingToken,pairId,secret,expiresAt,desktopName}=p;return `eve://pair?data=${Buffer.from(JSON.stringify({v,relayUrl,routingToken,pairId,secret,expiresAt,desktopName})).toString('base64url')}`;}
