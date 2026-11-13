import React, {useEffect, useRef, useState} from 'react';

const ROOT = '/api/reconstruction';
const TERMINAL = new Set(['SUCCEEDED','FAILED','CANCELED','CREATE_UNCERTAIN']);
const LABELS = {PENDING:'等待生成',IN_PROGRESS:'正在生成',SUCCEEDED:'生成完成',FAILED:'生成失败',CANCELED:'已取消',CREATING:'正在提交',CREATE_UNCERTAIN:'需核对提交状态'};
const PENDING_KEY = 'form3d-pending-reconstruction';
const UUID = /^[0-9a-f-]{36}$/i;
function savedPending(){try{const id=localStorage.getItem(PENDING_KEY);return UUID.test(id||'')?id:null}catch{return null}}
function savePending(id){try{id?localStorage.setItem(PENDING_KEY,id):localStorage.removeItem(PENDING_KEY)}catch{}}
async function request(path, options={}){
 const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(), options.method==='POST'?70000:30000);
 try{
  const r=await fetch(ROOT+path,{credentials:'same-origin',...options,signal:controller.signal});
  const body=await r.json().catch(()=>null);
  if(!r.ok){const e=new Error(body?.error||'服务暂时无法处理请求，请稍后查询。');e.code=body?.code;e.status=r.status;throw e}
  if(!body||typeof body!=='object')throw new Error('服务返回了无法识别的结果。');
  return body;
 } catch(e){if(e.name==='AbortError')throw new Error('请求超时，请先查询任务状态，避免重复提交。');throw e}
 finally{clearTimeout(timer)}
}
async function prepareImage(file){
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>20*1024*1024)throw new Error('请选择不超过 20 MB 的 JPG、PNG 或 WebP 图片。');
 let bitmap;
 try{bitmap=await createImageBitmap(file)}catch{throw new Error('图片无法解码，请换一张有效图片。')}
 try{
  if(bitmap.width<32||bitmap.height<32)throw new Error('图片宽高均需至少 32 像素。');
  if(bitmap.width*bitmap.height>25000000)throw new Error('图片超过 2500 万像素，请先缩小图片。');
  const ratio=Math.min(1,1536/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(32,Math.round(bitmap.width*ratio));canvas.height=Math.max(32,Math.round(bitmap.height*ratio));
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('当前浏览器无法处理图片。');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob||blob.size>8*1024*1024)throw new Error('处理后的图片仍超过 8 MB，请缩小后重试。');
  return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('无法读取处理后的图片。'));r.readAsDataURL(blob)});
 } finally{bitmap.close()}
}
async function modelBlob(path){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);
 try{
  const response=await fetch(ROOT+path,{credentials:'same-origin',signal:controller.signal});
  if(!response.ok){const error=await response.json().catch(()=>null);throw new Error(error?.error||'模型下载失败，请确认任务未过期。')}
  const limit=100*1024*1024;
  if(Number(response.headers.get('content-length'))>limit)throw new Error('模型超过 100 MB，请下载后在本机简化。');
  const reader=response.body?.getReader();if(!reader)throw new Error('无法读取模型文件。');
  const parts=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){await reader.cancel();throw new Error('模型超过 100 MB，请下载后在本机简化。')}parts.push(value)}
  return new Blob(parts,{type:'model/gltf-binary'});
 }catch(e){if(e.name==='AbortError')throw new Error('模型下载超时，请稍后重新加载。');throw e}
 finally{clearTimeout(timer)}
}
export default function PhotoReconstruction({kind,onKindChange,onModel}){
 const [connection,setConnection]=useState(null),[photo,setPhoto]=useState(null),[image,setImage]=useState(''),[processing,setProcessing]=useState(false),[consent,setConsent]=useState(false),[submitting,setSubmitting]=useState(false),[error,setError]=useState(''),[tasks,setTasks]=useState([]),[task,setTask]=useState(null),[pending,setPending]=useState(savedPending),[refreshing,setRefreshing]=useState(false),[loadingModel,setLoadingModel]=useState(false);
 const submitLock=useRef(false),sequence=useRef(0),alive=useRef(true),polling=useRef(false),requestId=useRef(savedPending());
 useEffect(()=>{alive.current=true;let cancelled=false;
  (async()=>{try{const status=await request('/status');if(cancelled)return;setConnection(status);if(status.authenticated){const data=await request('/tasks');if(cancelled)return;setTasks(data.tasks||[]);const prior=requestId.current&&(data.tasks||[]).find(t=>t.requestId===requestId.current);if(prior){setTask(prior);if(prior.status!=='CREATE_UNCERTAIN'){savePending(null);setPending(null);requestId.current=null}}}}catch(e){if(!cancelled)setError(e.message)}})();
  return()=>{cancelled=true;alive.current=false;sequence.current++};
 },[]);
 const updateTask=(next)=>{if(!alive.current)return;setTask(next);setTasks(old=>[next,...old.filter(x=>x.id!==next.id)].slice(0,20))};
 useEffect(()=>{
  if(!task?.id||TERMINAL.has(task.status))return;
  let stopped=false,timer;
  const tick=async()=>{if(stopped)return;if(polling.current){timer=setTimeout(tick,5000);return}polling.current=true;
   try{const next=await request('/tasks/'+encodeURIComponent(task.id));if(!stopped)updateTask(next)}catch(e){if(!stopped)setError(e.message)}finally{polling.current=false;if(!stopped)timer=setTimeout(tick,5000)}
  };
  timer=setTimeout(tick,5000);return()=>{stopped=true;clearTimeout(timer)};
 },[task?.id,task?.status]);
 async function select(e){const file=e.target.files?.[0];e.target.value='';if(!file)return;const s=++sequence.current;setError('');setProcessing(true);setConsent(false);setImage('');setPhoto(null);
  try{const data=await prepareImage(file);if(s!==sequence.current)return;setImage(data);setPhoto(file);if(!pending)requestId.current=null}catch(e){if(s===sequence.current)setError(e.message)}finally{if(s===sequence.current)setProcessing(false)}
 }
 async function refresh(){if(refreshing)return;setRefreshing(true);setError('');try{const c=await request('/status');setConnection(c);if(!c.authenticated)return;const data=await request('/tasks');setTasks(data.tasks||[]);const match=requestId.current&&(data.tasks||[]).find(t=>t.requestId===requestId.current);if(match){updateTask(match);if(match.status!=='CREATE_UNCERTAIN'){requestId.current=null;savePending(null);setPending(null)}}else if(task?.id){const found=(data.tasks||[]).find(x=>x.id===task.id);if(found)updateTask(found)}}catch(e){setError(e.message)}finally{setRefreshing(false)}}
 async function generate(){if(submitLock.current||!image||!consent||!connection?.configured||!connection?.authenticated||pending)return;submitLock.current=true;setSubmitting(true);setError('');
  const id=requestId.current||crypto.randomUUID();requestId.current=id;savePending(id);setPending(id);
  try{const next=await request('/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageDataUrl:image,consent:true,requestId:id})});updateTask(next);if(next.status!=='CREATE_UNCERTAIN'){requestId.current=null;savePending(null);setPending(null)}}
  catch(e){setError(e.message+(e.status&&e.status<500?'':' 请先查询任务，暂勿重新提交。'));if(e.status&&e.status<500&&e.code!=='CREATE_UNCERTAIN'){requestId.current=null;savePending(null);setPending(null)}}
  finally{submitLock.current=false;setSubmitting(false)}
 }
 async function load(){if(!task?.hasGlb||loadingModel)return;setLoadingModel(true);setError('');try{const blob=await modelBlob('/tasks/'+encodeURIComponent(task.id)+'/model.glb');if(alive.current)onModel(new File([blob],`form3d-${task.id}.glb`,{type:'model/gltf-binary'}))}catch(e){if(alive.current)setError(e.message)}finally{if(alive.current)setLoadingModel(false)}}
 const active=task&&!TERMINAL.has(task.status),canGenerate=!!(connection?.configured&&connection?.authenticated&&image&&consent&&!processing&&!submitting&&!pending&&!active);
 return <div className="panel"><div className="head"><div><div className="eyebrow">FIG 1.0 / PHOTO TO 3D</div><h2>从一张照片生成模型</h2></div><span className="tag">{connection?.configured?'重建服务已配置':connection?'等待服务配置':'检查连接中'}</span></div><div className="body"><label className="upload blueprint">{image?<img className="photo" src={image} alt="待生成模型的照片"/>:<><span className="plus">＋</span><strong>{processing?'正在处理图片…':'选择一张主体清晰的照片'}</strong><p>JPG / PNG / WebP · 不超过 20 MB</p><span className="outline">选择图片　↗</span></>}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={select} disabled={processing||submitting}/></label>{photo&&<p className="filename">{photo.name} · 已在浏览器缩小并转为 PNG</p>}<div className="field"><label>制作对象</label><div className="choices">{['人像','宠物','手办','器物','建筑','植物'].map(x=><button className={kind===x?'selected':''} onClick={()=>onKindChange(x)} key={x}>{x}</button>)}</div></div>
 {!connection?.configured&&<div className="notice"><strong>{connection?'图片重建服务待配置':'正在检查重建服务'}</strong><br/>网站接入已就绪，配置服务端 Meshy API 密钥和额度后才可生成。选择照片只会在浏览器预览。</div>}
 {connection&&!connection.authenticated&&<div className="notice">工作台可公开浏览。生成服务目前由项目组使用，请先<a href="/login" target="_top">团队登录</a>后生成或查看任务。</div>}
 {connection?.authenticated&&<div className="notice">已登录团队工作台，任务记录由项目组共享。<a href="/logout">退出登录</a></div>}
 <label style={{display:'flex',alignItems:'flex-start',gap:10,marginTop:18,fontSize:12,lineHeight:1.7,color:'#647a96'}}><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} disabled={submitting} style={{marginTop:4}}/><span>我同意将处理后的照片发送给 Meshy 生成 3D 模型；生成会消耗服务额度，照片会按第三方政策处理。请仅上传有权使用的图片。</span></label>
 <button className="primary" onClick={generate} disabled={!canGenerate}>{submitting?'正在提交，请勿关闭页面…':pending?'提交状态待核对':active?'模型生成中…':'生成 3D 模型　→'}</button>
 {error&&<div className="error" role="alert">{error}</div>}
 {pending&&<div className="notice">已保留本次请求标识。请先查询任务；若仍未找到，请由管理员核对 Meshy 后再重新创建，避免重复计费。</div>}
 {task&&<div className="summary" aria-live="polite"><div className="row"><b>{LABELS[task.status]||task.status}</b><span className="tag">{Number.isFinite(task.progress)?Math.round(task.progress)+'%':''}</span></div><progress max="100" value={Number.isFinite(task.progress)?task.progress:0} style={{width:'100%',margin:'12px 0',accentColor:'#174e9e'}}/><p>任务 {task.id}</p>{task.error&&<p>{task.error}</p>}{task.status==='SUCCEEDED'&&<><p>生成模型仍需检查实际可打印性。请及时下载保存，第三方文件链接会过期。</p><div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:12}}>{task.hasGlb&&<button className="outline" onClick={load} disabled={loadingModel}>{loadingModel?'正在加载…':'加载到 3D 预览'}</button>}{task.hasGlb&&<a className="outline" href={ROOT+'/tasks/'+encodeURIComponent(task.id)+'/model.glb'} download>下载 GLB</a>}{task.hasStl&&<a className="outline" href={ROOT+'/tasks/'+encodeURIComponent(task.id)+'/model.stl'} download>下载 STL</a>}</div></>}</div>}
 <div className="row" style={{marginTop:18}}><b style={{fontSize:13}}>我的重建任务</b><button className="outline" style={{padding:'8px 12px'}} onClick={refresh} disabled={refreshing||submitting}>{refreshing?'查询中…':'查询任务'}</button></div>
 {!tasks.length?<p style={{marginTop:10}}>暂无可显示的任务。</p>:<div style={{marginTop:10}}>{tasks.map(t=><button key={t.id} className="outline" onClick={()=>{setTask(t);setError('')}} style={{width:'100%',marginTop:7,textAlign:'left',padding:11,display:'flex',justifyContent:'space-between',gap:10}}><span>{t.id.slice(0,12)}…</span><span>{LABELS[t.status]||t.status}</span></button>)}</div>}
 </div></div>;
}
