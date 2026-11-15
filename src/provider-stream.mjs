import { createStreamRedactor } from './config.mjs';
const failure=message=>Object.assign(new Error(message),{code:'PROTOCOL'});
export async function readSSE(response,{signal,config,onDelta=()=>{}}) {
 const reader=response.body.getReader(),decoder=new TextDecoder(),redactor=createStreamRedactor(config);
 let buffer='',size=0,count=0,ended=false,finished=false,content='',usage={},finishReason;
 const calls=new Map();
 const event=block=>{
  const text=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
  if(!text)return;
  if(++count>20000)throw failure('模型流事件超过限额');
  if(text==='[DONE]'){ended=true;return;}
  let data;try{data=JSON.parse(text);}catch{throw failure('模型流包含无效 JSON');}
  if(data.error)throw failure('模型流报告错误，请检查服务状态');
  if(data.usage)usage=data.usage;
  const choice=data.choices?.[0];if(!choice)return;
  if(finished&&Object.keys(choice.delta||{}).length)throw failure('模型流结束后仍返回内容');
  const delta=choice.delta||{};
  if(delta.role!=null&&delta.role!=='assistant')throw failure('模型流角色无效');
  if(delta.tool_calls!=null&&!Array.isArray(delta.tool_calls))throw failure('模型流工具列表无效');
  if(delta.content!=null){if(typeof delta.content!=='string')throw failure('模型流 content 无效');content+=delta.content;const safe=redactor.push(delta.content);if(safe)onDelta(safe);}
  for(const part of delta.tool_calls||[]) {
   if(!Number.isInteger(part.index)||part.index<0||part.index>=100)throw failure('模型流工具索引无效');
   if((part.id!=null&&typeof part.id!=='string')||(part.function?.name!=null&&typeof part.function.name!=='string')||(part.function?.arguments!=null&&typeof part.function.arguments!=='string'))throw failure('模型流工具字段无效');
   const call=calls.get(part.index)||{id:'',type:'function',function:{name:'',arguments:''}};
   if(part.id)call.id+=part.id;
   if(part.type&&part.type!=='function')throw failure('模型流工具类型无效');
   if(part.function?.name)call.function.name+=part.function.name;
   if(part.function?.arguments)call.function.arguments+=part.function.arguments;
   calls.set(part.index,call);
  }
  if(choice.finish_reason!=null){finishReason=choice.finish_reason;finished=true;}
 };
 const abort=()=>{reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 try {
  for(;;){signal?.throwIfAborted();const {done,value}=await reader.read();signal?.throwIfAborted();if(done)break;size+=value.byteLength;if(size>2097152)throw failure('模型流超过 2 MiB');buffer+=decoder.decode(value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let i;while((i=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,i);buffer=buffer.slice(i+2);if(ended&&block.trim())throw failure('模型流结束后有额外数据');event(block);}}
  buffer+=decoder.decode();if(buffer.trim())event(buffer);
  if(!finished)throw failure('模型流中断，未执行不完整工具调用');
  const tail=redactor.flush();if(tail)onDelta(tail);
  return {choices:[{message:{role:'assistant',content,tool_calls:[...calls.entries()].sort((a,b)=>a[0]-b[0]).map(([,v])=>v)},finish_reason:finishReason}],usage};
 } finally {redactor.discard();signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
}
