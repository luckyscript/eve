import fs from 'node:fs/promises';
import { RemoteConnector, remoteStatus } from './remote.mjs';
import { RemoteStore, inviteURI } from './remote-store.mjs';
export async function remoteCLI(cwd,command,o={},pos=[]){
 const store=await RemoteStore.open(cwd),print=x=>console.log(JSON.stringify(x,null,2));
 if(command==='pair'){
  const settings=await store.settings();if(!settings.enabled||!settings.relayUrl)throw new Error('Enable remote access before pairing');
  // Deliberate local credential disclosure, only this explicit command writes the URI.
  console.log(inviteURI(await store.invite()));return;
 }
 if(command==='status'||!command){print(await remoteStatus(store));return;}
 if(command==='configure') {if(!o.file)throw new Error('remote configure --file PRIVATE_JSON');const st=await fs.lstat(o.file);if(!st.isFile()||st.isSymbolicLink()||st.size>65536)throw new Error('Invalid settings file');await store.configure(JSON.parse(await fs.readFile(o.file,'utf8')));print({saved:true});return;}
 if(command==='enable'){const old=await store.settings();await store.configure({enabled:true,...(o['relay-url']?{relayUrl:o['relay-url']}:{}),...(o.name?{desktopName:o.name}:{}),development:o['dev-loopback']||old.development});print({enabled:true,next:'eve remote start (foreground)'});return;}
 if(['disable','stop'].includes(command)){await store.configure({enabled:false});print({enabled:false,message:'Connector stops and cancels active remote work; partial writes are retained.'});return;}
 if(command==='revoke'){if(!pos[0])throw new Error('remote revoke PAIR_ID');await store.revoke(pos[0]);print({revoked:true,message:'Running connector observes revocation within one second.'});return;}
 if(command==='start'){
  const c=new RemoteConnector(store);await c.start();console.log('Remote connector running in foreground; credentials are never logged.');
  await new Promise(resolve=>{const done=()=>{process.removeListener('SIGINT',done);process.removeListener('SIGTERM',done);c.stop().finally(resolve);};process.once('SIGINT',done);process.once('SIGTERM',done);const monitor=setInterval(()=>{if(!c.enabled){clearInterval(monitor);done();}},500);monitor.unref();});return;
 }
 throw new Error('remote: enable --relay-url HTTPS_URL [--dev-loopback] | start | status | pair | revoke PAIR_ID | disable | configure --file PRIVATE_JSON');
}
