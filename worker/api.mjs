import * as meshy from '../integration/meshy.mjs';
import {normalizedPng} from './image.mjs';
const PREFIX='/api/reconstruction';
const ACTIVE=['CREATING','CREATE_UNCERTAIN','PENDING','IN_PROGRESS'];
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function taskPublic(t){let assets={};try{assets=JSON.parse(t.assets_json||'{}')}catch{}
 return {id:t.id,requestId:t.request_id,status:t.status,progress:t.progress,createdAt:t.created_at,expiresAt:t.expires_at,error:t.error,hasGlb:!!assets.glb,hasStl:!!assets.stl};}
async function bodyJson(request){
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw Object.assign(new Error('请求格式无效。'),{status:415});
 const limit=12*1024*1024;const length=Number(request.headers.get('content-length'));if(length>limit)throw Object.assign(new Error('图片请求过大。'),{status:413});
 const reader=request.body?.getReader();if(!reader)throw new Error('请求为空。');let count=0;const parts=[];
 try{while(true){const {value,done}=await reader.read();if(done)break;count+=value.length;if(count>limit)throw Object.assign(new Error('图片请求过大。'),{status:413});parts.push(value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}
 try{return JSON.parse(await new Blob(parts).text())}catch{throw Object.assign(new Error('请求格式无效。'),{status:400});}
}
export function createApi({adapter=meshy,now=Date.now}={}){
 return async function api(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(!path.startsWith(PREFIX))return null;
  try{
   const user=request.headers.get('oai-authenticated-user-id');
   if(!user&&path===PREFIX+'/status'&&request.method==='GET')return json({configured:false,authenticated:false});
   if(!user)return json({error:'请先登录后使用照片重建。',code:'UNAUTHENTICATED'},401);
   const configured=typeof env.MESHY_API_KEY==='string'&&!!env.MESHY_API_KEY.trim();
   if(path===PREFIX+'/status'&&request.method==='GET')return json({configured:configured&&!!env.DB,authenticated:true,provider:'Meshy',maxTasksPerDay:3});
   if(!env.DB)return json({error:'任务存储尚未就绪。',code:'STORAGE_NOT_CONFIGURED'},503);
   if(!['GET','POST'].includes(request.method))return json({error:'请求方法不支持。'},405);
   if(request.method==='POST'){
    if(request.headers.get('origin')!==url.origin||request.headers.get('sec-fetch-site')==='cross-site')return json({error:'请求来源无效。',code:'ORIGIN_NOT_ALLOWED'},403);
   }
   const db=env.DB,t=now();
   if(path===PREFIX+'/tasks'&&request.method==='GET'){
    const result=await db.prepare('SELECT * FROM reconstruction_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').bind(user).all();
    return json({tasks:result.results.map(taskPublic)});
   }
   if(path===PREFIX+'/tasks'&&request.method==='POST'){
    if(!configured)return json({error:'照片重建服务尚未配置。',code:'NOT_CONFIGURED'},503);
    const input=await bodyJson(request);
    if(!input||input.consent!==true||!uuid.test(input.requestId||''))return json({error:'请确认照片处理说明后再提交。',code:'INVALID_INPUT'},400);
    const prior=await db.prepare('SELECT * FROM reconstruction_tasks WHERE user_id = ? AND request_id = ?').bind(user,input.requestId).first();
    if(prior)return json(taskPublic(prior));
    const bytes=await normalizedPng(input.imageDataUrl);
    const id=crypto.randomUUID(),day=Math.floor(t/86400000)*86400000;
    // One statement makes admission atomic across isolates. Uncertain jobs keep the slot.
    const inserted=await db.prepare(`INSERT INTO reconstruction_tasks (id,user_id,request_id,status,created_at,updated_at,consent_at)
      SELECT ?,?,?,'CREATING',?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM reconstruction_tasks WHERE user_id=? AND status IN ('CREATING','CREATE_UNCERTAIN','PENDING','IN_PROGRESS'))
      AND (SELECT COUNT(*) FROM reconstruction_tasks WHERE user_id=? AND created_at>=?)<3
      AND (SELECT COUNT(*) FROM reconstruction_tasks WHERE created_at>=?)<10
      ON CONFLICT(user_id,request_id) DO NOTHING`).bind(id,user,input.requestId,t,t,t,user,user,day,day).run();
    if(!inserted.meta.changes){
     const existing=await db.prepare('SELECT * FROM reconstruction_tasks WHERE user_id=? AND request_id=?').bind(user,input.requestId).first();
     if(existing)return json(taskPublic(existing));
     return json({error:'已有任务正在处理，或已达到今日任务上限。',code:'TASK_LIMIT'},429);
    }
    try{
     const remote=await adapter.createImageTo3D(env,bytes);
     await db.prepare("UPDATE reconstruction_tasks SET remote_id=?,status='PENDING',updated_at=? WHERE id=?").bind(remote,now(),id).run();
    }catch(e){
     const knownRejection=['INVALID_CREDENTIAL','RATE_LIMITED','INSUFFICIENT_CREDITS'].includes(e.code)||(Number.isInteger(e.status)&&e.status>=400&&e.status<500&&![408,409].includes(e.status));
     const status=knownRejection?'FAILED':'CREATE_UNCERTAIN';
     const message=knownRejection?'服务商未接受任务，请检查服务配置和额度。':'任务提交结果不确定，请联系管理员核对，避免重复计费。';
     await db.prepare('UPDATE reconstruction_tasks SET status=?,error=?,updated_at=? WHERE id=?').bind(status,message,now(),id).run();
    }
    const saved=await db.prepare('SELECT * FROM reconstruction_tasks WHERE id=?').bind(id).first();return json(taskPublic(saved),202);
   }
   const match=path.match(/^\/api\/reconstruction\/tasks\/([0-9a-f-]{36})(?:\/(model\.(?:glb|stl)))?$/);
   if(!match||!uuid.test(match[1])||request.method!=='GET')return json({error:'未找到此接口。'},404);
   let task=await db.prepare('SELECT * FROM reconstruction_tasks WHERE id=? AND user_id=?').bind(match[1],user).first();
   if(!task)return json({error:'任务不存在。'},404);
   if(!match[2]){
    if(task.remote_id&&['PENDING','IN_PROGRESS'].includes(task.status)&&t-task.last_polled_at>=5000){
     const lock=await db.prepare('UPDATE reconstruction_tasks SET last_polled_at=? WHERE id=? AND last_polled_at<=?').bind(t,task.id,t-5000).run();
     if(lock.meta.changes){
      try{
       const result=await adapter.getImageTo3D(env,task.remote_id);
       if(result.id!==task.remote_id)throw new Error('Mismatched upstream ID');
       const expiry=typeof result.expiresAt==='number'?result.expiresAt:null;
       await db.prepare('UPDATE reconstruction_tasks SET status=?,progress=?,expires_at=?,assets_json=?,error=?,updated_at=? WHERE id=?').bind(result.status,result.progress??0,expiry,JSON.stringify(result.assets||{}),result.error??null,now(),task.id).run();
      }catch{return json({...taskPublic(task),pollError:'暂时无法查询进度，请稍后再试。'});}
      task=await db.prepare('SELECT * FROM reconstruction_tasks WHERE id=?').bind(task.id).first();
     }
    }
    return json(taskPublic(task));
   }
   if(task.status!=='SUCCEEDED')return json({error:'模型尚未生成。'},409);
   if(task.expires_at&&task.expires_at<t)return json({error:'模型下载链接已过期，请联系管理员。',code:'ASSET_EXPIRED'},410);
   let assets;try{assets=JSON.parse(task.assets_json||'{}')}catch{return json({error:'模型记录无效。'},502)}
   const ext=match[2].endsWith('glb')?'glb':'stl',asset=assets[ext];if(!asset)return json({error:'此模型格式不可用。'},404);
   const remote=new URL(asset);if(remote.protocol!=='https:'||remote.hostname!=='assets.meshy.ai'||remote.username||remote.password||remote.port)return json({error:'模型下载地址无效。'},502);
   const upstream=await fetch(remote,{redirect:'error',signal:AbortSignal.timeout(60000)});
   if(!upstream.ok||!upstream.body)return json({error:'模型暂时无法下载或已过期。'},502);
   if(Number(upstream.headers.get('content-length'))>100*1024*1024)return json({error:'模型过大，请联系管理员下载。'},413);
   let transferred=0;const stream=upstream.body.pipeThrough(new TransformStream({transform(chunk,controller){transferred+=chunk.length;if(transferred>100*1024*1024){controller.error(new Error('Model too large'));return}controller.enqueue(chunk)}}));
   return new Response(stream,{headers:{'content-type':ext==='glb'?'model/gltf-binary':'application/octet-stream','content-disposition':`attachment; filename="form3d-${task.id}.${ext}"`,'cache-control':'no-store','x-content-type-options':'nosniff'}});
  }catch(e){
   if(e.status&&e.status<500)return json({error:e.message,code:'INVALID_INPUT'},e.status);
   if(e.message?.startsWith('PNG')||e.message?.startsWith('请使用')||e.message?.startsWith('图片')||e.message?.startsWith('请上传'))return json({error:e.message,code:'INVALID_IMAGE'},400);
   return json({error:'服务处理失败，请稍后重试或联系管理员。',code:'SERVICE_ERROR'},503);
  }
 };
}
export const api=createApi();
