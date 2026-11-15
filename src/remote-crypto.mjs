import { createHash, createHmac, hkdfSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
export const hash = s => createHash('sha256').update(s).digest('hex');
export function bytes(s, length) {
 if(typeof s!=='string'||!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('Invalid encoding');
 const b=Buffer.from(s,'base64url'); if(b.toString('base64url')!==s||(length!==undefined&&b.length!==length)) throw new Error('Invalid encoding'); return b;
}
export function proof(secret,direction,pairId,clientId,clientNonce,serverNonce) {
 return createHmac('sha256',bytes(secret,32)).update(`eve-relay-v1\n${direction}\n${pairId}\n${clientId}\n${clientNonce}\n${serverNonce}`).digest('base64url');
}
export function equalProof(a,b) { try { return timingSafeEqual(bytes(a,32),bytes(b,32)); } catch { return false; } }
export function keys(secret,cn,sn) {
 const salt=Buffer.concat([bytes(cn,32),bytes(sn,32)]);
 return Object.fromEntries(['c2s','s2c'].map(d=>[d,Buffer.from(hkdfSync('sha256',bytes(secret,32),salt,`eve-relay-v1:${d}`,32))]));
}
const MAX=512*1024;
export class Cipher {
 constructor(key,direction){this.key=key;this.direction=direction;this.seq=0;}
 nonce(seq){const n=Buffer.alloc(12);n.writeBigUInt64BE(BigInt(seq),4);return n;}
 aad(seq){return Buffer.from(`eve-relay-v1\n${this.direction}\n${seq}`);}
 encrypt(value){
  const seq=this.seq+1; if(seq>2147483647) throw new Error('Sequence exhausted');
  const c=createCipheriv('aes-256-gcm',this.key,this.nonce(seq)); c.setAAD(this.aad(seq));
  const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final(),c.getAuthTag()]).toString('base64url');
  const frame={v:1,type:'encrypted',seq,data}; if(Buffer.byteLength(JSON.stringify(frame))>MAX) throw new Error('Response limit'); this.seq=seq; return frame;
 }
 decrypt(f){
  if(!f||f.v!==1||f.type!=='encrypted'||!Number.isInteger(f.seq)||f.seq!==this.seq+1||f.seq>2147483647||typeof f.data!=='string'||f.data.length>MAX) throw new Error('Invalid frame');
  const b=bytes(f.data); if(b.length<16||b.length>65536+16) throw new Error('Request limit');
  const d=createDecipheriv('aes-256-gcm',this.key,this.nonce(f.seq));d.setAAD(this.aad(f.seq));d.setAuthTag(b.subarray(-16));
  const plain=Buffer.concat([d.update(b.subarray(0,-16)),d.final()]);const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(plain));this.seq=f.seq;return value;
 }
}
export function relayURL(value,dev=false){
 let u;try{u=new URL(value);}catch{throw new Error('Invalid relay URL');}
 if(u.username||u.password||u.search||u.hash||!['https:','wss:','http:','ws:'].includes(u.protocol)||!['','/'].includes(u.pathname)) throw new Error('Invalid relay URL');
 if(!['https:','wss:'].includes(u.protocol)&&!(dev&&['127.0.0.1','[::1]','localhost'].includes(u.hostname))) throw new Error('Relay requires TLS or explicit loopback development mode');
 u.protocol=u.protocol==='wss:'?'https:':u.protocol==='ws:'?'http:':u.protocol;return u.origin;
}
