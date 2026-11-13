import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {createImageTo3D, getImageTo3D, createPrintAnalysis, getPrintAnalysis, deleteImageTask} from './meshy.mjs';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const env = {MESHY_API_KEY:'test-secret'};
const png = Uint8Array.from([137,80,78,71,13,10,26,10,1]);
const json = x => new Response(JSON.stringify(x),{status:200,headers:{'content-type':'application/json'}});
test('submits validated image to fixed endpoint using only server secret', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url,'https://api.meshy.ai/openapi/v1/image-to-3d');
    assert.equal(options.headers.Authorization,'Bearer test-secret');
    assert.equal(options.redirect,'error');
    const data = JSON.parse(options.body);
    assert.equal(data.image_url, 'data:image/png;base64,iVBORw0KGgoB');
    assert.deepEqual(data.target_formats,['glb','stl']);
    return json({result:'example-task-id'});
  };
  assert.equal(await createImageTo3D(env,png),'example-task-id');
});
test('rejects invalid photo and task id before network', async () => {
  globalThis.fetch = () => { throw new Error('network should not run'); };
  await assert.rejects(createImageTo3D(env,new Uint8Array([1,2,3])),{code:'INVALID_INPUT'});
  await assert.rejects(getImageTo3D(env,'../../other'),{code:'INVALID_INPUT'});
  await assert.rejects(createImageTo3D({},png),{code:'NOT_CONFIGURED'});
});
test('forwards print size and printer for provider analysis', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url,'https://api.meshy.ai/openapi/v1/print/analyze');
    assert.deepEqual(JSON.parse(options.body),{input_task_id:'task-id',printer_type:'sla',intended_print_height_mm:150});
    return json({result:'analysis-id'});
  };
  assert.equal(await createPrintAnalysis(env,'task-id',{printerType:'sla',heightMm:150}),'analysis-id');
  await assert.rejects(createPrintAnalysis(env,'task-id',{printerType:'sla',heightMm:1001}),{code:'INVALID_INPUT'});
});
test('returns safe asset hosts and analysis details, not arbitrary URLs', async () => {
  globalThis.fetch = async url => url.includes('/print/analyze/')
    ? json({id:'analysis-id',status:'SUCCEEDED',progress:100,printability:{status:'warning'}})
    : json({id:'task-id',status:'SUCCEEDED',progress:100,model_urls:{glb:'https://assets.meshy.ai/path/model.glb?sig=abc',stl:'https://evil.example/model.stl'}});
  assert.deepEqual((await getImageTo3D(env,'task-id')).assets,{glb:'https://assets.meshy.ai/path/model.glb?sig=abc'});
  assert.deepEqual((await getPrintAnalysis(env,'analysis-id')).printability,{status:'warning'});
});
test('does not retry paid POST on failure and redacts response', async () => {
  let count = 0;
  globalThis.fetch = async () => { count++; return new Response('private upstream response',{status:429}); };
  await assert.rejects(createImageTo3D(env,png), err => err.code==='RATE_LIMITED' && !err.message.includes('private'));
  assert.equal(count,1);
});
test('propagates in-progress delete conflict', async () => {
  globalThis.fetch = async () => new Response('',{status:409});
  await assert.rejects(deleteImageTask(env,'task-id'), {status:409});
});
