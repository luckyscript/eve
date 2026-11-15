// Reference test client for the frozen Eve contract; no credentials are logged.
import { randomBytes, randomUUID } from 'node:crypto';
import { proof, equalProof, keys, Cipher } from '../src/remote-crypto.mjs';
export class TestClient {
 static async connect(invite,{clientId=randomUUID(),secret=invite.secret}={}){
  const c=new TestClient();c.clientId=clientId;c.events=[];c.pending=new Map();c.frames=[];c.waiters=[];
  const url=new URL(`/c/${invite.routingToken}/__eve_remote__`,invite.relayUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  c.ws=new WebSocket(url);c.ws.addEventListener('message',e=>{try{const f=JSON.parse(e.data);if(c.input){const v=c.input.decrypt(f);if(v.kind==='response'){const p=c.pending.get(v.id);if(p){c.pending.delete(v.id);clearTimeout(p.timer);p.resolve(v);}}else c.events.push(v);}else if(c.waiters.length)c.waiters.shift().resolve(f);else c.frames.push(f);}catch{c.ws.close();}});
  c.ws.addEventListener('close',()=>{c.closed=true;for(const p of c.pending.values()){clearTimeout(p.timer);p.reject(new Error('Disconnected'));}c.pending.clear();for(const w of c.waiters)w.reject(new Error('Disconnected'));c.waiters=[];});
  await new Promise((resolve,reject)=>{c.ws.addEventListener('open',resolve,{once:true});c.ws.addEventListener('error',()=>reject(new Error('Connection failed')),{once:true});});
  try{
   const cn=randomBytes(32).toString('base64url');c.send({v:1,type:'hello',pairId:invite.pairId,clientId,clientName:'Protocol test client',clientNonce:cn});
   const challenge=await c.next();if(!equalProof(challenge.proof,proof(secret,'server',invite.pairId,clientId,cn,challenge.serverNonce)))throw new Error('Server identity rejected');
   c.send({v:1,type:'authenticate',proof:proof(secret,'client',invite.pairId,clientId,cn,challenge.serverNonce)});
   const k=keys(secret,cn,challenge.serverNonce);const ready=await c.next();c.input=new Cipher(k.s2c,'s2c');c.output=new Cipher(k.c2s,'c2s');if(c.input.decrypt(ready).kind!=='ready')throw new Error('Missing ready');return c;
  }catch(e){c.ws.close();throw e;}
 }
 constructor(){}
 next(){if(this.frames.length)return Promise.resolve(this.frames.shift());return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Handshake timeout')),12000);this.waiters.push({resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});});}
 send(v){this.ws.send(JSON.stringify(v));}
 request(op,params={},id=randomUUID()){
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Request timeout'));},180000);this.pending.set(id,{resolve,reject,timer});this.send(this.output.encrypt({kind:'request',id,op,params}));});
 }
 close(){this.ws.close();}
}
