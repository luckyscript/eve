import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withAbort } from '../src/agent.mjs';
test('already aborted operation still observes the started request rejection',async()=>{
 const controller=new AbortController(); controller.abort(new Error('already stopped'));
 await assert.rejects(withAbort(Promise.reject(new Error('late request failure')),controller.signal),/already stopped/);
 await new Promise(resolve=>setImmediate(resolve));
});
