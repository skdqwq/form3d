import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from './database.mjs';
import {refreshTaskAssets} from './refresh-assets.mjs';

const fetchOriginal=globalThis.fetch;afterEach(()=>{globalThis.fetch=fetchOriginal;});
const taskId='12345678-1234-1234-1234-123456789012',user='test-team',time=2_000_000_000_000;
const env={MESHY_REGION:'cn',MESHY_API_KEY:'test-key'};
const oldAssets={glb:'https://assets.meshy.ai/old/model.glb?Signature=old',stl:'https://assets.meshy.ai/old/model.stl?Signature=old'};
const freshAssets={glb:'https://assets.meshy.cn/new/model.glb?Signature=new%2Fglb%3D&Expires=42',stl:'https://assets.meshy.cn/new/model.stl?Signature=new%2Fstl%3D&Expires=42'};
function setup(t){const db=openDatabase(':memory:');t.after(()=>db.close());db.raw.prepare("INSERT INTO reconstruction_tasks (id,user_id,request_id,remote_id,status,created_at,updated_at,consent_at,assets_json) VALUES (?,?,?,'remote-test','SUCCEEDED',?,?,?,?)").run(taskId,user,'request-test',time,time,time,JSON.stringify(oldAssets));return db;}
const result=()=>({id:'remote-test',status:'SUCCEEDED',assets:freshAssets,expiresAt:time+600000});
const stored=db=>db.raw.prepare('SELECT * FROM reconstruction_tasks WHERE id=?').get(taskId);

test('cross-region refresh uses one authenticated GET and atomically stores newly signed URLs without rewriting hosts',async t=>{
 const db=setup(t);let calls=0;
 globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'https://api.meshy.cn/openapi/v1/image-to-3d/remote-test');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');return new Response(JSON.stringify({id:'remote-test',status:'SUCCEEDED',model_urls:freshAssets,expires_at:time+600000}));};
 const before=stored(db);assert.deepEqual(await refreshTaskAssets({db,env,taskId,expectedUser:user,now:()=>time+1}),{updated:true,region:'cn',formats:['glb','stl']});
 const after=stored(db);assert.deepEqual(JSON.parse(after.assets_json),freshAssets);assert.equal(after.expires_at,time+600000);assert.equal(after.status,before.status);assert.equal(after.remote_id,before.remote_id);assert.equal(after.user_id,before.user_id);assert.equal(calls,1);
});

test('refresh refuses another owner, upstream identity/status mismatch, unexpected hosts and expired assets without writing',async t=>{
 const db=setup(t),before=stored(db);let calls=0;
 const adapter={async getImageTo3D(){calls++;return result();}};
 await assert.rejects(refreshTaskAssets({db,env,taskId,expectedUser:'other-user',adapter,now:()=>time+1}));assert.equal(calls,0);
 const variants=[{id:'wrong-task'},{status:'IN_PROGRESS'},{assets:{...freshAssets,glb:oldAssets.glb}},{assets:{...freshAssets,glb:'https://assets.meshy.cn.evil.example/model.glb'}},{assets:{glb:freshAssets.glb}},{expiresAt:time-1}];
 for(const change of variants){adapter.getImageTo3D=async()=>({...result(),...change});await assert.rejects(refreshTaskAssets({db,env,taskId,expectedUser:user,adapter,now:()=>time+1}));assert.deepEqual(stored(db),before);}
});

test('refresh compare-and-swap refuses to overwrite concurrent task changes',async t=>{
 const db=setup(t);const adapter={async getImageTo3D(){db.raw.prepare('UPDATE reconstruction_tasks SET assets_json=? WHERE id=?').run(JSON.stringify({glb:'https://assets.meshy.ai/concurrent.glb'}),taskId);return result();}};
 await assert.rejects(refreshTaskAssets({db,env,taskId,expectedUser:user,adapter,now:()=>time+1}),/changed/);
 assert.deepEqual(JSON.parse(stored(db).assets_json),{glb:'https://assets.meshy.ai/concurrent.glb'});
});
