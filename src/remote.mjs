import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hash, bytes, proof, equalProof, keys, Cipher, relayURL } from './remote-crypto.mjs';
import { RemoteStore, inviteURI } from './remote-store.mjs';
import { RemoteService } from './remote-service.mjs';
import { atomicPrivate, readPrivate } from './registry.mjs';
const identifier=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
export class RemoteConnector {
 static async create(cwd,options={}){return new RemoteConnector(await RemoteStore.open(cwd),options);}
 constructor(store,options={}){this.store=store;this.service=new RemoteService(store,options);this.tunnels=new Map();this.enabled=false;this.ticking=false;this.startTime=Date.now();this.options=options;}
 async start(){if(this.enabled)return this.status();this.release=await this.store.lock('connector.lock');try{await this.store.recover();const s=await this.store.settings();if(!s.enabled)throw new Error('Enable remote access locally first');relayURL(s.relayUrl,s.development);this.enabled=true;await this.refresh();this.poll=setInterval(()=>this.refresh().catch(()=>this.stop()),1000);return this.status();}catch(e){await this.release();this.release=null;throw e;}}
 async refresh(){
  if(!this.enabled||this.ticking)return;this.ticking=true;
  try{const settings=await this.store.settings();if(!settings.enabled){queueMicrotask(()=>this.stop());return;}
   const signature=JSON.stringify([settings.relayUrl,settings.development,settings.registrationKey]);if(this.signature&&signature!==this.signature){for(const t of this.tunnels.values())this.closeTunnel(t);this.tunnels.clear();}this.signature=signature;
   const pairs=await this.store.pairs(),valid=new Set(pairs.map(p=>p.pairId));
   for(const [id,t]of this.tunnels)if(!valid.has(id)){this.closeTunnel(t);this.tunnels.delete(id);this.service.cancelPair(id);}
   for(const pair of pairs)if(!this.tunnels.has(pair.pairId)){const t={pair,settings,peers:new Map(),attempt:0,state:'connecting',closed:false};this.tunnels.set(pair.pairId,t);this.connect(t);}
   await this.publish();
  }finally{this.ticking=false;}
 }
 send(t,f){if(t.socket?.readyState!==WebSocket.OPEN||t.socket.bufferedAmount>2*1024*1024)throw new Error('Transport unavailable');t.socket.send(JSON.stringify(f));}
 connect(t){
  if(t.closed||!this.enabled)return;
  const base=relayURL(t.settings.relayUrl,t.settings.development),url=new URL('/agent',base);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('th',hash(t.pair.routingToken));
  const ws=t.socket=new WebSocket(url),peers=t.peers=new Map();t.state='connecting';let finished=false;
  const timeout=setTimeout(()=>{ws.close();finish();},10000);
  const finish=()=>{if(finished)return;finished=true;clearTimeout(timeout);clearInterval(t.healthTimer);for(const p of peers.values())this.closePeer(t,p,false);peers.clear();if(t.closed||!this.enabled)return;t.state=t.blocked?'blocked':'reconnecting';if(!t.blocked){const cap=Math.min(60000,500*2**Math.min(t.attempt++,8));t.retry=setTimeout(()=>this.connect(t),Math.floor(cap*(0.5+Math.random()*0.5)));}this.publish().catch(()=>{});};
  ws.addEventListener('open',()=>{try{this.send(t,{t:'register',tokenHash:hash(t.pair.routingToken),proto:1,...(t.settings.registrationKey?{key:t.settings.registrationKey}:{})});}catch{ws.close();finish();}});
  ws.addEventListener('message',e=>{
   if(finished||t.socket!==ws)return;
   try{
    if(typeof e.data!=='string'||Buffer.byteLength(e.data)>768*1024)throw new Error();const f=JSON.parse(e.data);
    if(f.t==='registered'){if((f.proto??1)!==1)throw new Error();clearTimeout(timeout);t.state='online';t.attempt=0;t.lastHealthy=Date.now();
     clearInterval(t.healthTimer);t.healthTimer=setInterval(async()=>{try{const r=await fetch(new URL('/healthz',base),{signal:AbortSignal.timeout(7000),redirect:'error'});await r.body?.cancel();if(!r.ok)throw new Error();t.lastHealthy=Date.now();}catch{ws.close();finish();}},15000);this.publish().catch(()=>{});return;}
    if(f.t==='error'){t.blocked=true;ws.close();finish();return;}
    if(t.state!=='online'||!identifier(f.id))throw new Error();
    if(f.t==='hreq'){this.send(t,{t:'hres',id:f.id,status:403,headers:{'content-type':'text/plain'}});this.send(t,{t:'hend',id:f.id});}
    else if(f.t==='wopen'){
     if(f.path!=='/__eve_remote__'||peers.size>=32||peers.has(f.id)){this.send(t,{t:'werr',id:f.id,message:'Denied'});return;}
     const p={id:f.id,state:'hello',pending:0};peers.set(p.id,p);p.timeout=setTimeout(()=>this.closePeer(t,p),10000);this.send(t,{t:'wopened',id:p.id});
    }else if(f.t==='wclose'){const p=peers.get(f.id);if(p)this.closePeer(t,p,false);}
    else if(f.t==='wmsg'){
     const p=peers.get(f.id);if(!p)return;
     if(typeof f.s!=='string'||Buffer.byteLength(f.s)>512*1024){this.closePeer(t,p);return;}
     this.message(t,p,f.s).catch(()=>this.closePeer(t,p));
    }
   }catch{ws.close();finish();}
  });
  ws.addEventListener('error',()=>{ws.close();finish();});ws.addEventListener('close',e=>{if([4000,4002,4003,4401].includes(e.code))t.blocked=true;finish();});
 }
 async message(t,p,text){
  if(p.closed)return;const f=JSON.parse(text);
  if(p.state==='hello'){
   if(f.v!==1||f.type!=='hello'||f.pairId!==t.pair.pairId||!identifier(f.clientId)||typeof f.clientName!=='string'||!f.clientName.trim()||f.clientName.length>80||/[\x00-\x1f]/.test(f.clientName))throw new Error();bytes(f.clientNonce,32);
   p.hello=f;p.serverNonce=randomBytes(32).toString('base64url');p.state='authenticate';
   this.send(t,{t:'wmsg',id:p.id,s:JSON.stringify({v:1,type:'challenge',serverNonce:p.serverNonce,proof:proof(t.pair.secret,'server',f.pairId,f.clientId,f.clientNonce,p.serverNonce)})});return;
  }
  if(p.state==='authenticate'){
   const h=p.hello;if(f.v!==1||f.type!=='authenticate'||!equalProof(f.proof,proof(t.pair.secret,'client',h.pairId,h.clientId,h.clientNonce,p.serverNonce)))throw new Error();p.state='binding';
   await this.store.bind(t.pair.pairId,h.clientId,Date.now(),h.clientName);if(p.closed||t.closed)return;
   const k=keys(t.pair.secret,h.clientNonce,p.serverNonce);p.input=new Cipher(k.c2s,'c2s');p.output=new Cipher(k.s2c,'s2c');p.state='ready';clearTimeout(p.timeout);
   this.payload(t,p,{kind:'ready',clientId:h.clientId,desktopName:t.settings.desktopName,protocol:1});return;
  }
  if(p.state!=='ready'||++p.pending>32)throw new Error();
  const q=p.input.decrypt(f);
  try{const response=await this.service.request(t.pair.pairId,q,event=>{try{this.payload(t,p,event);}catch{this.closePeer(t,p);}});if(!p.closed)this.payload(t,p,response);}finally{p.pending--;}
 }
 payload(t,p,value){if(p.closed)return;let f;try{f=p.output.encrypt(value);}catch{f=p.output.encrypt({kind:'response',id:value.id??null,ok:false,error:{code:'LIMIT',message:'Response exceeds frame limit; use smaller session projection.'}});}this.send(t,{t:'wmsg',id:p.id,s:JSON.stringify(f)});}
 closePeer(t,p,notify=true){if(p.closed)return;p.closed=true;clearTimeout(p.timeout);t.peers.delete(p.id);if(notify)try{this.send(t,{t:'wclose',id:p.id,code:1008,reason:'Closed'});}catch{};p.input=null;p.output=null;}
 closeTunnel(t){t.closed=true;clearTimeout(t.retry);clearInterval(t.healthTimer);for(const p of t.peers.values())this.closePeer(t,p);t.socket?.close();}
 status(){return {enabled:this.enabled,pid:process.pid,startedAt:this.startTime,updatedAt:Date.now(),busy:this.service.active,connections:[...this.tunnels.values()].map(t=>({pairId:t.pair.pairId,state:t.state,lastHealthy:t.lastHealthy,authenticated:[...t.peers.values()].filter(p=>p.state==='ready').length}))};}
 async publish(){await atomicPrivate(path.join(this.store.dir,'runtime.json'),this.status());}
 async invite(){const p=await this.store.invite();await this.refresh();return {pairId:p.pairId,expiresAt:p.expiresAt,uri:inviteURI(p)};}
 async revoke(id){const r=await this.store.revoke(id);const t=this.tunnels.get(id);if(t){this.closeTunnel(t);this.tunnels.delete(id);}this.service.cancelPair(id);await this.publish();return r;}
 async stop(){if(this.stopping)return this.stopping;this.stopping=(async()=>{this.enabled=false;clearInterval(this.poll);for(const t of this.tunnels.values())this.closeTunnel(t);this.tunnels.clear();await this.service.stop();await this.publish();if(this.release){await this.release();this.release=null;}})();return this.stopping;}
}
export async function remoteStatus(store){const status=await store.status();let runtime={enabled:false};try{const r=await readPrivate(path.join(store.dir,'runtime.json'));let live=false;try{process.kill(r.pid,0);live=Date.now()-r.updatedAt<5000;}catch{}if(live)runtime=r;}catch{}return {...status,runtime};}
