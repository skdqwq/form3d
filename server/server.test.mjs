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
async function setup(t,{env={},api,accessToken=token,now}={}) {
  const folder=await mkdtemp(join(tmpdir(),'form3d-test-'));
  await mkdir(join(folder,'public')); await writeFile(join(folder,'public/index.html'),'<!doctype html><title>Form3D</title>');
  await writeFile(join(folder,'secret.txt'),'never public');
  const db=openDatabase(join(folder,'database.sqlite'));
  const config={...configuration({...env,FORM3D_ACCESS_TOKEN:accessToken,SESSION_SECRET:secret}),staticDir:join(folder,'public')};
  const {server}=createAppServer({config,db,api,now});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`; config.origin=origin;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();await rm(folder,{recursive:true,force:true})});
  return {origin,server,db,config,folder};
}
async function login(s,other={}) {
  return fetch(s.origin+'/auth/login',{method:'POST',redirect:'manual',headers:{origin:s.origin,'content-type':'application/x-www-form-urlencoded',...other},body:new URLSearchParams({token:s.config.accessToken})});
}

test('a 10-character team code signs in while sessions use the independent strong secret',async t=>{
  const accessToken='DemoTest42'; // Synthetic fixture only, never a deployed credential.
  const s=await setup(t,{accessToken});
  const page=await(await fetch(s.origin+'/login')).text();
  assert.match(page,/团队登录码/);assert.match(page,/minlength="3"/);assert.match(page,/maxlength="512"/);
  assert.match(page,/生成需算力费用/);assert.doesNotMatch(page,new RegExp(accessToken));
  const wrong=await fetch(s.origin+'/auth/login',{method:'POST',headers:{origin:s.origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:'DemoTest43'})});
  assert.equal(wrong.status,401);assert.match(await wrong.text(),/登录码不正确/);
  const signed=await login(s);assert.equal(signed.status,303);
  const cookie=signed.headers.get('set-cookie').split(';')[0],session=readSession(cookie);
  assert.equal(verifySession(session,secret),'self-hosted-admin');
  assert.equal(verifySession(session,accessToken),null);
  assert.equal((await(await fetch(s.origin+'/api/reconstruction/status',{headers:{cookie}})).json()).authenticated,true);
  assert.equal(s.db.raw.prepare('SELECT COUNT(*) AS n FROM reconstruction_tasks').get().n,0);
});

test('three-character Chinese team codes sign in with trimmed input and keep session signing independent',async t=>{
  const accessToken='山海云'; // Synthetic fixture only, never a deployed credential.
  const s=await setup(t,{accessToken:' \u3000'+accessToken+'\u3000 '});
  assert.equal(s.config.accessToken,accessToken);
  const page=await(await fetch(s.origin+'/login')).text();
  assert.match(page,/minlength="3"/);assert.doesNotMatch(page,new RegExp(accessToken));
  const submit=(body,origin=s.origin)=>fetch(s.origin+'/auth/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body});
  const body=new URLSearchParams({token:' \u3000'+accessToken+'\u3000 '});
  assert.equal((await submit(body,'https://evil.example')).status,403);
  assert.equal((await submit(new URLSearchParams({token:'山海雨'}))).status,401);
  assert.equal((await submit(new URLSearchParams([['token',accessToken],['token',accessToken]]))).status,401);
  assert.equal((await submit(new URLSearchParams({token:accessToken+'\n'}))).status,401);
  const signed=await submit(body);assert.equal(signed.status,303);
  const cookie=signed.headers.get('set-cookie').split(';')[0],session=readSession(cookie);
  assert.equal(verifySession(session,secret),'self-hosted-admin');
  assert.equal(verifySession(session,accessToken),null);
  assert.equal((await(await fetch(s.origin+'/api/reconstruction/status',{headers:{cookie}})).json()).authenticated,true);
  assert.equal((await fetch(s.origin+'/api/reconstruction/tasks')).status,401);
  assert.equal(s.db.raw.prepare('SELECT COUNT(*) AS n FROM reconstruction_tasks').get().n,0);
});

test('configuration and submitted codes use the same NFC normalization',async t=>{
  const s=await setup(t,{accessToken:'Cafe\u0301-Demo42'});
  assert.equal(s.config.accessToken,'Café-Demo42');
  for(const token of ['Café-Demo42','Cafe\u0301-Demo42']){
    const response=await fetch(s.origin+'/auth/login',{method:'POST',redirect:'manual',headers:{origin:s.origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});
    assert.equal(response.status,303);
  }
});

test('a valid 512-character code survives form encoding within the bounded login body',async t=>{
  const s=await setup(t,{accessToken:'A1'+'测'.repeat(510)});
  assert.equal((await login(s)).status,303);
});
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
  let time=2_000_000_000_000;
  const s=await setup(t,{accessToken:'山海云',now:()=>time});
  for(let i=0;i<10;i++) assert.equal((await fetch(s.origin+'/auth/login',{method:'POST',headers:{origin:s.origin,'content-type':'application/x-www-form-urlencoded','x-forwarded-for':`1.2.3.${i}`},body:'token=wrong'})).status,401);
  assert.equal((await login(s,{'x-forwarded-for':'4.5.6.7'})).status,429);
  time+=15*60*1000;
  assert.equal((await login(s)).status,303);
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
  assert.throws(()=>configuration({FORM3D_ACCESS_TOKEN:'replace-with-a-random-long-secret-value',SESSION_SECRET:secret}),/FORM3D_ACCESS_TOKEN/);
  assert.throws(()=>configuration({FORM3D_ACCESS_TOKEN:token,SESSION_SECRET:token}),/differ/);
  assert.equal(configuration({APP_ORIGIN:'https://form3d.example.com',FORM3D_ACCESS_TOKEN:token,SESSION_SECRET:secret}).secure,true);
});

test('login code validation rejects weak or malformed values without weakening the session secret',()=>{
  const env={FORM3D_ACCESS_TOKEN:'DemoTest42',SESSION_SECRET:secret};
  for(const bad of [undefined,42,'','   ','山海','山 海云','山海1','abc','A1b','A1'+'b'.repeat(511),'山'.repeat(513),'Abcd12345','1234567890','abcdefghij',
    'Demo\tTest42','Demo\nTest42','Demo\0Test42','Demo\u007fTest42','Demo\u0085Test42',
    'change-me123','ReplaceThis42','exampleCode42','your-code123','YourCode42']){
    assert.throws(()=>configuration({...env,FORM3D_ACCESS_TOKEN:bad}),/FORM3D_ACCESS_TOKEN/);
  }
  for(const bad of [undefined,42,'s'.repeat(31),' '+secret,secret+' ',secret+'\t','replace-with-at-least-32-random-characters']){
    assert.throws(()=>configuration({...env,SESSION_SECRET:bad}),/SESSION_SECRET/);
  }
  assert.equal(configuration({...env,SESSION_SECRET:'s'.repeat(32)}).sessionSecret.length,32);
  assert.equal(configuration({...env,FORM3D_ACCESS_TOKEN:' \u3000山海云\u3000 '}).accessToken,'山海云');
  assert.equal(configuration({...env,FORM3D_ACCESS_TOKEN:' DemoTest42 '}).accessToken,'DemoTest42');
  assert.throws(()=>configuration({FORM3D_ACCESS_TOKEN:token,SESSION_SECRET:token}),/differ/);
  assert.throws(()=>configuration({FORM3D_ACCESS_TOKEN:' '+token+' ',SESSION_SECRET:token}),/differ/);
});

test('region configuration defaults to global, rejects arbitrary URLs and reaches the worker env',async t=>{
  const base={FORM3D_ACCESS_TOKEN:token,SESSION_SECRET:secret};
  assert.equal(configuration(base).meshyRegion,'global');
  for(const MESHY_REGION of ['','https://evil.example','__proto__'])assert.throws(()=>configuration({...base,MESHY_REGION}),/MESHY_REGION/);
  const s=await setup(t,{env:{MESHY_REGION:'cn'},api:async(request,env)=>new Response(JSON.stringify({region:env.MESHY_REGION}))});
  assert.equal((await(await fetch(s.origin+'/api/reconstruction/status')).json()).region,'cn');
});
