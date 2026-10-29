import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolExecutor } from '@qubicl/control/executor';
import { QubiclError, errorPayload } from '../../packages/control/dist/errors.js';
import { TransparentLeaseBridge } from '../../packages/cli/dist/mcp.js';

test('bridge retries only proven non-execution across pre-dispatch and post-dispatch ownership loss', async (context) => {
  const savedFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = savedFetch; });
  for (const stage of ['before', 'after', 'return', 'legacy'] as const) {
    let calls = 0; let dispatches = 0; let boundary = false;
    const proof = {id:'a'.repeat(32), epoch:'b'.repeat(16), generation:1};
    const executor = Object.assign(Object.create(ToolExecutor.prototype), {
      audit: {record: () => undefined},
      leases: {verify: () => {if(boundary) throw new QubiclError('stale_lease','expired',409);}, revokeAgentControlFor: async () => undefined},
      executeCall: async () => {
        calls += 1;
        if(stage === 'before' && calls === 1) throw new QubiclError('stale_lease','expired before dispatch',409,{dispatch:'not-started'});
        if(stage === 'legacy') throw new QubiclError('stale_lease','unknown old-server state',409);
        dispatches += 1;
        if(stage === 'after') throw new QubiclError('action_result_uncertain','post-dispatch expiry',409,{dispatch:'started'});
        if(stage === 'return') boundary = true;
        return {clicked:true};
      },
    }) as ToolExecutor;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const name = new URL(String(input)).pathname.split('/').pop();
      if(name === 'acquire_lease') return Response.json(proof);
      try {return Response.json(await executor.call('browser_click',{ref:'g1e1',lease:proof}));}
      catch(error) {return Response.json(errorPayload(error),{status:409});}
    }) as typeof fetch;
    const result = await new TransparentLeaseBridge('http://computer.test','token').call('browser_click',{ref:'g1e1'});
    assert.equal(result.ok,stage === 'before',stage);
    assert.equal(dispatches,stage === 'legacy' ? 0 : 1,stage);
    assert.equal(calls,stage === 'before' ? 2 : 1,stage);
  }
});
