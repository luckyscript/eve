import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { proof, keys, Cipher, relayURL } from '../src/remote-crypto.mjs';
import { RemoteStore } from '../src/remote-store.mjs';

const secret=Buffer.alloc(32,7).toString('base64url'), cn=Buffer.alloc(32,1).toString('base64url'), sn=Buffer.alloc(32,2).toString('base64url');
test('mutual authentication, direction keys, strict sequence and tamper rejection',()=>{
 assert.notEqual(proof(secret,'server','pair','client',cn,sn),proof(secret,'client','pair','client',cn,sn));
 const k=keys(secret,cn,sn), c=new Cipher(k.c2s,'c2s'), s=new Cipher(k.c2s,'c2s');
 const frame=c.encrypt({kind:'request'}); assert.deepEqual(s.decrypt(frame),{kind:'request'}); assert.throws(()=>s.decrypt(frame));
 const bad=new Cipher(k.c2s,'c2s'), corrupt={...frame,data:Buffer.alloc(20).toString('base64url')}; assert.throws(()=>bad.decrypt(corrupt));
 assert.throws(()=>new Cipher(keys(Buffer.alloc(32,8).toString('base64url'),cn,sn).c2s,'c2s').decrypt(frame));
});
test('transport URL rejects credentials and nonloopback dev',()=>{
 assert.throws(()=>relayURL('http://example.com',true)); assert.throws(()=>relayURL('ws://127.0.0.1',false));
 assert.throws(()=>relayURL('https://user:pass@example.com',false)); assert.throws(()=>relayURL('https://example.com/?token=secret',false));
 assert.equal(relayURL('http://127.0.0.1:3333',true),'http://127.0.0.1:3333');
});
test('private store consumes invite once, permits bound reconnect, enforces expiry and revoke',async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'eve-remote-')); t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
 const s=await RemoteStore.open(cwd); const invite=await s.invite();
 assert.equal((await fs.stat(path.join(cwd,'.eve/remote/state.json'))).mode&0o777,0o600);
 await assert.rejects(()=>s.bind(invite.pairId,'client',Date.now()+600001));
 await s.bind(invite.pairId,'client'); await s.bind(invite.pairId,'client',Date.now()+600001);
 await assert.rejects(()=>s.bind(invite.pairId,'other')); await s.revoke(invite.pairId); await assert.rejects(()=>s.bind(invite.pairId,'client'));
});
test('ledger canonical identity, pair isolation and crash unresolved never replays',async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'eve-ledger-')); t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
 const s=await RemoteStore.open(cwd), id=randomUUID();
 assert.equal((await s.begin('a',id,'run.start',{prompt:'x',sessionId:'s'})).fresh,true);
 assert.equal((await s.begin('a',id,'run.start',{sessionId:'s',prompt:'x'})).fresh,false);
 await assert.rejects(()=>s.begin('a',id,'run.start',{prompt:'y'})); await assert.rejects(()=>s.lookup('b',id));
 await s.recover(); assert.equal((await s.lookup('a',id)).state,'unknown');
 assert.equal((await s.begin('a',id,'run.start',{sessionId:'s',prompt:'x'})).fresh,false);
});
