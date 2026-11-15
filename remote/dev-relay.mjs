#!/usr/bin/env node
// Downloads upstream solely into ignored verification scratch; no global dependencies.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const revision='30d56513aefc4d96b624d878af758aaa5468d9f8';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function command(cmd,args,options={}){return new Promise((resolve,reject)=>{const p=spawn(cmd,args,{stdio:'pipe',...options});let error='';p.stderr?.on('data',b=>{error+=b;});p.stdout?.resume();p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(`${cmd} failed (${code}); inspect local installation`)));});}
export async function prepareRelay(){
 const dir=path.join(root,'.eve','verify-remote-relay'),repo=path.join(dir,'source');await fs.mkdir(dir,{recursive:true,mode:0o700});
 try{if((await fs.readFile(path.join(dir,'revision'),'utf8'))===revision){await fs.access(path.join(repo,'node_modules/ws'));return repo;}}catch{}
 await fs.rm(repo,{recursive:true,force:true});await fs.mkdir(repo,{mode:0o700});
 const r=await fetch(`https://codeload.github.com/yetone/alma-relay/tar.gz/${revision}`,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error('Pinned relay download failed');
 const tar=path.join(dir,'upstream.tgz');await fs.writeFile(tar,Buffer.from(await r.arrayBuffer()));
 await command('tar',['-xzf',tar,'--strip-components=1','-C',repo]);await fs.rm(tar);
 // Only runtime dependency is ws. Avoid installing upstream development tooling.
 await fs.writeFile(path.join(repo,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{ws:'8.18.3'}}));await fs.rm(path.join(repo,'package-lock.json'),{force:true});
 await command('npm',['install','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:repo});await fs.writeFile(path.join(dir,'revision'),revision);return repo;
}
export async function startRelay(port=0){
 const repo=await prepareRelay();if(!port){const net=await import('node:net');const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));port=s.address().port;await new Promise(r=>s.close(r));}
 let logs='';const child=spawn(process.execPath,[path.join(repo,'index.mjs')],{cwd:repo,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),HOST:'127.0.0.1',RELAY_PROTOCOL:'1'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 const url=`http://127.0.0.1:${port}`;
 for(let n=0;n<150;n++){try{const r=await fetch(url+'/healthz');if(r.ok)return {child,url,logs:()=>logs,stop:()=>new Promise(resolve=>{if(child.exitCode!==null){resolve();return;}child.once('exit',resolve);child.kill('SIGTERM');})};}catch{}if(child.exitCode!==null)throw new Error('Pinned relay exited');await new Promise(r=>setTimeout(r,100));}
 child.kill();throw new Error('Relay start timeout');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const r=await startRelay(Number(process.env.PORT||8787));console.log(`Pinned Alma Relay ${revision} on ${r.url}; PID ${r.child.pid}; explicit loopback development only.`);for(const s of ['SIGINT','SIGTERM'])process.once(s,async()=>{await r.stop();});}
