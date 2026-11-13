import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {createAppServer, configuration} from './index.mjs';
import {openDatabase} from './database.mjs';
import {issueSession, verifySession, readSession} from './auth.mjs';

const token='test-access-token-with-ample-length-123456';
const secret='different-session-secret-for-test-123456';
async function setup(t,{env={},api}={}) {
  const folder=await mkdtemp(join(tmpdir(),'form3d-test-'));
  await mkdir(join(folder,'public')); await writeFile(join(folder,'public/index.html'),'<!doctype html><title>Form3D</title>');
  await writeFile(join(folder,'secret.txt'),'never public');
  const db=openDatabase(join(folder,'database.sqlite'));
  const config={...configuration({...env,FORM3D_ACCESS_TOKEN:token,SESSION_SECRET:secret}),staticDir:join(folder,'public')};
  const {server}=createAppServer({config,db,api});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`; config.origin=origin;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();await rm(folder,{recursive:true,force:true})});
  return {origin,server,db,config,folder};
}
async function login(s,other={}) {
  return fetch(s.origin+'/auth/login',{method:'POST',redirect:'manual',headers:{origin:s.origin,'content-type':'application/x-www-form-urlencoded',...other},body:new URLSearchParams({token})});
}
test('public page and unconfigured status work; forged identity never authenticates',async t=>{
  const s=await setup(t);
  assert.equal((await fetch(s.origin)).status,200);
  const headers={'oai-authenticated-user-id':'victim','x-forwarded-user':'victim'};
  const status=await (await fetch(s.origin+'/api/reconstruction/status',{headers})).json();
  assert.deepEqual(status,{configured:false,authenticated:false});
  assert.equal((await fetch(s.origin+'/api/reconstruction/tasks',{headers})).status,401);
  const signed=await login(s);assert.equal(signed.status,303);
  assert.match(signed.headers.get('set-cookie'),/HttpOnly/);assert.match(signed.headers.get('set-cookie'),/SameSite=Strict/);
  const cookie=signed.headers.get('set-cookie').split(';')[0];
  const active=await (await fetch(s.origin+'/api/reconstruction/status',{headers:{cookie}})).json();
  assert.equal(active.authenticated,true);assert.equal(active.configured,false);
  const post=await fetch(s.origin+'/api/reconstruction/tasks',{method:'POST',headers:{cookie,origin:s.origin,'content-type':'application/json'},body:'{}'});
  assert.equal(post.status,503);assert.equal((await post.json()).code,'NOT_CONFIGURED');
});
test('configured public service status does not grant a forged identity or generation access',async t=>{
  const s=await setup(t,{env:{MESHY_API_KEY:'test-only-key-not-for-network',MESHY_REGION:'cn'}});
  const headers={'oai-authenticated-user-id':'self-hosted-admin','x-forwarded-user':'self-hosted-admin'};
  const response=await fetch(s.origin+'/api/reconstruction/status',{headers});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{configured:true,authenticated:false});
  assert.equal((await fetch(s.origin+'/api/reconstruction/tasks',{headers})).status,401);
  assert.equal((await fetch(s.origin+'/api/reconstruction/tasks',{method:'POST',headers:{...headers,origin:s.origin,'content-type':'application/json'},body:'{}'})).status,401);
  const signed=await login(s),cookie=signed.headers.get('set-cookie').split(';')[0];
  const authenticated=await fetch(s.origin+'/api/reconstruction/status',{headers:{cookie}});
  assert.deepEqual(await authenticated.json(),{configured:true,authenticated:true,provider:'Meshy',maxTasksPerDay:3});
  assert.equal(s.db.raw.prepare('SELECT COUNT(*) AS n FROM reconstruction_tasks').get().n,0);
});
test('login rejects absent/cross Origin; protected POST and logout reject CSRF',async t=>{
  const s=await setup(t);
  assert.equal((await login(s,{origin:'https://evil.example'})).status,403);
  assert.equal((await fetch(s.origin+'/auth/login',{method:'POST',body:'token=x'})).status,403);
  const signed=await login(s),cookie=signed.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(s.origin+'/api/reconstruction/tasks',{method:'POST',headers:{cookie,origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await fetch(s.origin+'/auth/logout',{method:'POST',headers:{cookie}})).status,403);
  const out=await fetch(s.origin+'/auth/logout',{method:'POST',headers:{cookie,origin:s.origin},redirect:'manual'});
  assert.equal(out.status,303);assert.match(out.headers.get('set-cookie'),/Max-Age=0/);
});
test('signatures, expiry, duplicate cookies and future claims are rejected',()=>{
  const now=2_000_000_000_000,session=issueSession(secret,now);
  assert.equal(verifySession(session,secret,now),'self-hosted-admin');
  assert.equal(verifySession(session,secret,now+8*3600*1000),null);
  assert.equal(verifySession(session+'x',secret,now),null);
  assert.equal(verifySession(session,'not-the-secret',now),null);
  assert.equal(verifySession(issueSession(secret,now+60_000),secret,now),null);
  assert.equal(readSession('form3d_session=a; form3d_session=b'),null);
});
test('login is rate limited and forwarded addresses do not bypass the limit',async t=>{
  const s=await setup(t);
  for(let i=0;i<10;i++) assert.equal((await fetch(s.origin+'/auth/login',{method:'POST',headers:{origin:s.origin,'content-type':'application/x-www-form-urlencoded','x-forwarded-for':`1.2.3.${i}`},body:'token=wrong'})).status,401);
  assert.equal((await login(s,{'x-forwarded-for':'4.5.6.7'})).status,429);
});
function rawGet(origin,path,headers={}) {
  return new Promise((resolve,reject)=>{const req=httpRequest(new URL(origin),{path,headers},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body}))});req.on('error',reject);req.end()});
}
test('static path traversal, encoded paths, hidden files and absolute request targets fail closed',async t=>{
  const s=await setup(t);
  for(const path of ['/../secret.txt','/%2e%2e/secret.txt','/%2e%2e%2fsecret.txt','/..%5csecret.txt','/.env','//example.com/x','/%00x','http://evil.example/']){
    const result=await rawGet(s.origin,path);assert.equal(result.status,400,path);assert.doesNotMatch(result.body,/never public/);
  }
  assert.equal((await fetch(s.origin+'/missing')).status,404);
});
test('real database persists tasks, applies migration once, and API only lists the team identity',async t=>{
  const s=await setup(t),time=Date.now();
  s.db.raw.prepare("INSERT INTO reconstruction_tasks (id,user_id,request_id,status,created_at,updated_at,consent_at) VALUES (?,?,?,'FAILED',?,?,?)").run('team-task','self-hosted-admin','team-request',time,time,time);
  s.db.raw.prepare("INSERT INTO reconstruction_tasks (id,user_id,request_id,status,created_at,updated_at,consent_at) VALUES (?,?,?,'FAILED',?,?,?)").run('other-task','somebody-else','other-request',time,time,time);
  const signed=await login(s),cookie=signed.headers.get('set-cookie').split(';')[0];
  const list=await (await fetch(s.origin+'/api/reconstruction/tasks',{headers:{cookie,'oai-authenticated-user-id':'somebody-else'}})).json();
  assert.deepEqual(list.tasks.map(x=>x.id),['team-task']);
  const second=openDatabase(join(s.folder,'database.sqlite'));
  assert.equal(second.raw.prepare('SELECT COUNT(*) AS n FROM reconstruction_tasks').get().n,2);
  assert.equal(second.raw.prepare('SELECT COUNT(*) AS n FROM form3d_migrations').get().n,1);second.close();
});
test('declared oversized API payload is rejected before consuming it',async t=>{
  const s=await setup(t);
  const result=await rawGet(s.origin,'/api/reconstruction/status',{'content-length':String(12*1024*1024+1)});
  assert.equal(result.status,413);
});
test('public HTTP, default placeholders and equal secrets are refused',()=>{
  assert.throws(()=>configuration({APP_ORIGIN:'http://example.com',FORM3D_ACCESS_TOKEN:token,SESSION_SECRET:secret}),/HTTPS/);
  assert.throws(()=>configuration({FORM3D_ACCESS_TOKEN:'replace-with-a-random-long-secret-value',SESSION_SECRET:secret}),/random secret/);
  assert.throws(()=>configuration({FORM3D_ACCESS_TOKEN:token,SESSION_SECRET:token}),/differ/);
  assert.equal(configuration({APP_ORIGIN:'https://form3d.example.com',FORM3D_ACCESS_TOKEN:token,SESSION_SECRET:secret}).secure,true);
});

test('region configuration defaults to global, rejects arbitrary URLs and reaches the worker env',async t=>{
  const base={FORM3D_ACCESS_TOKEN:token,SESSION_SECRET:secret};
  assert.equal(configuration(base).meshyRegion,'global');
  for(const MESHY_REGION of ['','https://evil.example','__proto__'])assert.throws(()=>configuration({...base,MESHY_REGION}),/MESHY_REGION/);
  const s=await setup(t,{env:{MESHY_REGION:'cn'},api:async(request,env)=>new Response(JSON.stringify({region:env.MESHY_REGION}))});
  assert.equal((await(await fetch(s.origin+'/api/reconstruction/status')).json()).region,'cn');
});
