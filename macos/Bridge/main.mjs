import { BridgeHost, bridgeError, OUTPUT_LIMIT } from './host.mjs';
const MAX=262144;
let output=Promise.resolve(), queued=0, closing=false;
function send(value) {
 if(Buffer.byteLength(JSON.stringify(value))>OUTPUT_LIMIT+2048)value={requestID:value.requestID,type:'error',error:{code:'LIMIT',message:'响应超过字节限额，请使用 session.page 分页读取'}};
 const line=JSON.stringify(value)+'\n'; queued+=Buffer.byteLength(line);
 if(queued>8*1024*1024) { host.controllers.forEach(c=>c.abort()); process.stdin.pause(); closing=true; }
 output=output.then(()=>new Promise((resolve,reject)=>process.stdout.write(line,e=>e?reject(e):resolve()))).finally(()=>{queued-=Buffer.byteLength(line);});
 output.catch(()=>{host.controllers.forEach(c=>c.abort());process.exitCode=1;process.stdin.destroy();});
}
const host=new BridgeHost({onEvent:(requestID,event)=>send({requestID,type:'event',event})});
// EPIPE is a stream event as well as a write callback error. Absorb it and
// cooperatively settle the core operation instead of crashing during a write.
process.stdout.on('error',()=>{host.controllers.forEach(c=>c.abort());process.exitCode=1;process.stdin.destroy();});
const pending=new Set(), ids=new Set(); let buffer=Buffer.alloc(0), oversized=false;
function line(data) {
 let q;
 try { q=JSON.parse(data); if(!q||typeof q.requestID!=='string'||!/^[-a-zA-Z0-9]{1,80}$/.test(q.requestID)||ids.has(q.requestID)||typeof q.op!=='string'||Object.keys(q).some(k=>!['requestID','op','params'].includes(k))) throw new Error(); }
 catch {send({requestID:null,type:'error',error:{code:'PROTOCOL',message:'Invalid or duplicate request envelope'}});return;}
 ids.add(q.requestID); if(ids.size>100000) {closing=true;process.stdin.pause();return;}
 const job=host.call(q.op,q.params,q.requestID).then(result=>send({requestID:q.requestID,type:'result',result}),e=>send({requestID:q.requestID,type:'error',error:bridgeError(e)})).finally(()=>pending.delete(job)); pending.add(job);
}
process.stdin.on('data',chunk=>{
 buffer=Buffer.concat([buffer,chunk]); let i;
 while((i=buffer.indexOf(10))>=0) {const data=buffer.subarray(0,i);buffer=buffer.subarray(i+1);if(!oversized&&data.length<=MAX)line(data);else send({requestID:null,type:'error',error:{code:'LIMIT',message:'JSONL message exceeds limit'}});oversized=false;}
 if(buffer.length>MAX){buffer=Buffer.alloc(0);oversized=true;}
});
process.stdin.on('end',async()=>{closing=true;if(buffer.length)send({requestID:null,type:'error',error:{code:'EOF',message:'Incomplete JSONL frame'}});host.controllers.forEach(c=>c.abort());await Promise.allSettled([...pending]);await host.shutdown();await output.catch(()=>{});});
process.stdin.on('error',()=>{host.controllers.forEach(c=>c.abort());process.exitCode=1;});
