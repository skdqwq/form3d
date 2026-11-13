import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {createApi} from './api.mjs';

function crc32(bytes){let c=0xffffffff;for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;}return (c^0xffffffff)>>>0;}
function chunk(type,payload){const t=Buffer.from(type),b=Buffer.alloc(payload.length+12);b.writeUInt32BE(payload.length);t.copy(b,4);payload.copy(b,8);b.writeUInt32BE(crc32(Buffer.concat([t,payload])),b.length-4);return b;}
function png(){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(32,0);ihdr.writeUInt32BE(32,4);ihdr[8]=8;ihdr[9]=6;const raw=Buffer.alloc(32*(32*4+1));return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');}
function db(){
 const raw=new DatabaseSync(':memory:');
 raw.exec(readFileSync(new URL('../drizzle/0000_reconstruction.sql',import.meta.url),'utf8'));
 return {raw,prepare(sql){
  let args=[];const statement=raw.prepare(sql);
  return {
   bind(...x){args=x;return this},
   async first(){return statement.get(...args)??null},
   async all(){return {results:statement.all(...args)}},
   async run(){return {meta:{changes:Number(statement.run(...args).changes)}}}
  };
 }};
}
function req(path='',method='GET',user='alice',body){const headers={};if(user)headers['oai-authenticated-user-id']=user;if(method==='POST'){headers.origin='https://form3d.test';headers['content-type']='application/json';}return new Request('https://form3d.test/api/reconstruction'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});}
function input(requestId=randomUUID()){return {requestId,consent:true,imageDataUrl:png()};}
const fetchOriginal=globalThis.fetch;afterEach(()=>{globalThis.fetch=fetchOriginal;});
function setup(){const DB=db();let time=2_000_000_000_000,created=0,polled=0;const adapter={async createImageTo3D(){return 'remote-'+(++created)},async getImageTo3D(env,id){polled++;return {id,status:'SUCCEEDED',progress:100,expiresAt:time+300000,assets:{glb:'https://assets.meshy.ai/output/model.glb'}}}};return {DB,env:{DB,MESHY_API_KEY:'test-only-key'},api:createApi({adapter,now:()=>time}),adapter,setTime:t=>{time=t},counts:()=>({created,polled})};}
test('requires identity and configured secret; rejects cross-origin create',async()=>{const s=setup();assert.equal((await (await s.api(req('/status','GET',null),s.env)).json()).authenticated,false);assert.equal((await s.api(req('/tasks','GET',null),s.env)).status,401);assert.equal((await s.api(req('/tasks','POST','alice',input()),{DB:s.DB})).status,503);const cross=req('/tasks','POST','alice',input());cross.headers.set('origin','https://evil.example');assert.equal((await s.api(cross,s.env)).status,403);assert.equal(s.counts().created,0);});
test('anonymous status reports current readiness without credentials or paid access',async()=>{
 const s=setup();
 const response=await s.api(req('/status','GET',null),s.env);
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(await response.json(),{configured:true,authenticated:false});
 for(const env of [{DB:s.DB},{DB:s.DB,MESHY_API_KEY:'  '},{DB:s.DB,MESHY_API_KEY:'bad\nkey'},{MESHY_API_KEY:'test-only-key'}]){
  assert.deepEqual(await(await s.api(req('/status','GET',null),env)).json(),{configured:false,authenticated:false});
 }
 assert.deepEqual(await(await s.api(req('/status','GET',null),s.env)).json(),{configured:true,authenticated:false});
 assert.equal((await s.api(req('/tasks','GET',null),s.env)).status,401);
 assert.equal((await s.api(req('/tasks','POST',null,input()),s.env)).status,401);
 assert.equal((await s.api(req('/tasks/'+randomUUID()+'/model.glb','GET',null),s.env)).status,401);
 assert.deepEqual(s.counts(),{created:0,polled:0});
 assert.equal(s.DB.raw.prepare('SELECT COUNT(*) AS n FROM reconstruction_tasks').get().n,0);
});
test('status configuration errors are failures, not false unconfigured responses',async()=>{
 const s=setup();
 const response=await s.api(req('/status','GET',null),{...s.env,MESHY_REGION:'invalid-region'});
 assert.equal(response.status,503);
 assert.deepEqual(await response.json(),{error:'服务处理失败，请稍后重试或联系管理员。',code:'SERVICE_ERROR'});
 assert.deepEqual(s.counts(),{created:0,polled:0});
});
test('real SQLite admission, request idempotency and user isolation',async()=>{const s=setup(),body=input();let r=await s.api(req('/tasks','POST','alice',body),s.env);assert.equal(r.status,202);const task=await r.json();assert.equal(task.status,'PENDING');r=await s.api(req('/tasks','POST','alice',body),s.env);assert.equal((await r.json()).id,task.id);assert.equal(s.counts().created,1);assert.equal((await s.api(req('/tasks','POST','alice',input()),s.env)).status,429);assert.equal((await s.api(req('/tasks/'+task.id,'GET','bob'),s.env)).status,404);assert.equal((await s.api(req('/tasks/'+task.id+'/model.glb','GET','bob'),s.env)).status,404);assert.equal((await (await s.api(req('/tasks','GET','bob'),s.env)).json()).tasks.length,0);});
test('queries remote task then exposes authorized streaming model download',async()=>{const s=setup(),created=await (await s.api(req('/tasks','POST','alice',input()),s.env)).json();const done=await (await s.api(req('/tasks/'+created.id),s.env)).json();assert.equal(done.status,'SUCCEEDED');assert.equal(done.hasGlb,true);assert.equal('assets' in done,false);assert.equal(s.counts().polled,1);globalThis.fetch=async(url,options)=>{assert.equal(url.hostname,'assets.meshy.ai');assert.equal(options.redirect,'error');return new Response(new Uint8Array([1,2,3]),{headers:{'content-length':'3'}})};const download=await s.api(req('/tasks/'+created.id+'/model.glb'),s.env);assert.equal(download.status,200);assert.deepEqual([...new Uint8Array(await download.arrayBuffer())],[1,2,3]);assert.match(download.headers.get('content-disposition'),/attachment/);s.setTime(2_000_000_400_000);assert.equal((await s.api(req('/tasks/'+created.id+'/model.glb'),s.env)).status,410);});
test('SQLite enforces per-user three-per-day and global ten-per-day ceilings',async()=>{const s=setup();for(let i=0;i<10;i++){const user='user-'+Math.floor(i/3),r=await s.api(req('/tasks','POST',user,input()),s.env);assert.equal(r.status,202);const task=await r.json();assert.equal((await s.api(req('/tasks/'+task.id,'GET',user),s.env)).status,200);if(i===2)assert.equal((await s.api(req('/tasks','POST',user,input()),s.env)).status,429);}assert.equal((await s.api(req('/tasks','POST','fresh-user',input()),s.env)).status,429);assert.equal(s.counts().created,10);});
test('uncertain paid submission remains blocked and duplicate requests never resubmit',async()=>{const s=setup();s.adapter.createImageTo3D=async()=>{throw Object.assign(new Error('timeout'),{code:'NETWORK_ERROR'})};const body=input(),task=await (await s.api(req('/tasks','POST','alice',body),s.env)).json();assert.equal(task.status,'CREATE_UNCERTAIN');assert.equal((await s.api(req('/tasks','POST','alice',input()),s.env)).status,429);assert.equal((await (await s.api(req('/tasks','POST','alice',body),s.env)).json()).id,task.id);});
test('download rechecks provider domain even when database contains an unexpected URL',async()=>{const s=setup(),task=await (await s.api(req('/tasks','POST','alice',input()),s.env)).json();s.DB.raw.prepare("UPDATE reconstruction_tasks SET status='SUCCEEDED',assets_json=? WHERE id=?").run(JSON.stringify({glb:'https://evil.example/x.glb'}),task.id);globalThis.fetch=()=>{throw new Error('must not fetch')};assert.equal((await s.api(req('/tasks/'+task.id+'/model.glb'),s.env)).status,502);});
test('concurrent identical and distinct submissions admit only one remote task',async()=>{const s=setup(),body=input();const duplicate=await Promise.all([s.api(req('/tasks','POST','alice',body),s.env),s.api(req('/tasks','POST','alice',body),s.env)]);const records=await Promise.all(duplicate.map(r=>r.json()));assert.equal(records[0].id,records[1].id);assert.equal(s.counts().created,1);const t=setup();const competing=await Promise.all([t.api(req('/tasks','POST','alice',input()),t.env),t.api(req('/tasks','POST','alice',input()),t.env)]);assert.deepEqual(competing.map(r=>r.status).sort(),[202,429]);assert.equal(t.counts().created,1);});

test('cn download preserves the returned signature and rejects database SSRF URLs',async()=>{
 const s=setup();s.env.MESHY_REGION='cn';const task=await(await s.api(req('/tasks','POST','alice',input()),s.env)).json();
 const signed='https://assets.meshy.cn/fresh/path/model.glb?Signature=cn%2Fonly%3D&Expires=42';
 const update=asset=>s.DB.raw.prepare("UPDATE reconstruction_tasks SET status='SUCCEEDED',assets_json=? WHERE id=?").run(JSON.stringify({glb:asset}),task.id);
 update(signed);let calls=0;globalThis.fetch=async(url,options)=>{calls++;assert.equal(url.href,signed);assert.equal(options.redirect,'error');return new Response(new Uint8Array([7,8,9]));};
 const downloaded=await s.api(req('/tasks/'+task.id+'/model.glb'),s.env);assert.equal(downloaded.status,200);assert.deepEqual([...new Uint8Array(await downloaded.arrayBuffer())],[7,8,9]);
 for(const asset of ['https://assets.meshy.cn.evil.example/a','https://evil.assets.meshy.cn/a','https://user@assets.meshy.cn/a','https://assets.meshy.cn:8443/a','http://169.254.169.254/a','not-a-url']){update(asset);assert.equal((await s.api(req('/tasks/'+task.id+'/model.glb'),s.env)).status,502);}
 assert.equal(calls,1);
 update(signed);globalThis.fetch=async(url,options)=>{assert.equal(options.redirect,'error');return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});};
 assert.equal((await s.api(req('/tasks/'+task.id+'/model.glb'),s.env)).status,502);
});

test('invalid worker region fails before task admission or any paid submission',async()=>{
 const s=setup();s.env.MESHY_REGION='https://evil.example';assert.equal((await s.api(req('/tasks','POST','alice',input()),s.env)).status,503);
 assert.equal(s.counts().created,0);assert.equal(s.DB.raw.prepare('SELECT COUNT(*) AS n FROM reconstruction_tasks').get().n,0);
});
