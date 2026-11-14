import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
// A fixed read-only Git command; never a shell, alias or model-provided command.
export async function protectLocalConfig(cwd) {
 const env={HOME:process.env.HOME || '',PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
 try {
  const {stdout}=await exec('/usr/bin/git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','ls-files','--cached','--','.eve/config.local.json'],{cwd,env,maxBuffer:65536});
  if(stdout.trim()) throw new Error('本地配置已被 Git 跟踪；请先移出索引，再设置配置或密钥');
 } catch(e) {
  if(!(e.code===128 && e.stderr?.includes('not a git repository'))) throw e;
 }
 const file=path.join(cwd,'.gitignore');let old='';
 try {
  const st=await fs.lstat(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>1048576) throw new Error('.gitignore 必须为受限普通文件');
  old=await fs.readFile(file,'utf8');
 } catch(e) {if(e.code!=='ENOENT')throw e;}
 // Append at the end so earlier negation rules cannot expose local credentials.
 const rule='/.eve/config.local.json';
 const lines=old.trimEnd().split('\n');
 if(lines.at(-1)!==rule) {
  const handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
  try {await handle.writeFile((old.endsWith('\n')||!old?'':'\n')+rule+'\n');await handle.sync();}finally{await handle.close();}
 }
}
