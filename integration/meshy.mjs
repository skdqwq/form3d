// Server-only Meshy adapter. This is a library, not an HTTP handler.
// Caller must authenticate the user, authorize each task, enforce quotas and
// obtain informed photo-processing consent before invoking these functions.
const BASE = 'https://api.meshy.ai/openapi/v1';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export class MeshyError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'MeshyError';
    this.code = code;
    this.status = status;
  }
}
function keyFrom(env) {
  const key = env?.MESHY_API_KEY;
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key))
    throw new MeshyError('NOT_CONFIGURED', 'Meshy API 密钥未配置。');
  return key.trim();
}
function taskId(id) {
  if (typeof id !== 'string' || !ID.test(id))
    throw new MeshyError('INVALID_INPUT', '任务编号格式无效。');
  return id;
}
function imageType(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES)
    throw new MeshyError('INVALID_INPUT', '图片须为不超过 10 MiB 的 JPG、PNG 或 WebP。');
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)) return 'image/png';
  if (bytes.length >= 3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0,4))==='RIFF' && String.fromCharCode(...bytes.subarray(8,12))==='WEBP') return 'image/webp';
  throw new MeshyError('INVALID_INPUT', '图片文件格式无法识别。');
}
function imageDataUri(bytes) {
  const type = imageType(bytes);
  // Chunks avoid exceeding the argument limit. btoa is available in Workers.
  const chunks=[];
  for (let i=0; i<bytes.length; i+=0x6000) chunks.push(String.fromCharCode(...bytes.subarray(i,i+0x6000)));
  return `data:${type};base64,${btoa(chunks.join(''))}`;
}
async function request(env, path, method = 'GET', payload) {
  const key = keyFrom(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), method === 'POST' ? 60000 : 30000);
  try {
    let response;
    try {
      response = await fetch(BASE + path, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, ...(payload ? {'Content-Type':'application/json'} : {}) },
        ...(payload ? {body: JSON.stringify(payload)} : {})
      });
    } catch {
      // POST timeout does not prove the upstream task was not created; never auto-retry.
      throw new MeshyError('NETWORK_ERROR', '服务请求失败或超时；任务是否创建需要人工核对，避免重复计费。');
    }
    if (!response.ok) {
      const status = response.status;
      const code = status===401 ? 'INVALID_CREDENTIAL' : status===429 ? 'RATE_LIMITED' : status===402 ? 'INSUFFICIENT_CREDITS' : 'UPSTREAM_ERROR';
      throw new MeshyError(code, `Meshy 服务返回 HTTP ${status}。`, status);
    }
    if (method === 'DELETE') return;
    let result;
    try { result=await response.json(); }
    catch { throw new MeshyError('INVALID_RESPONSE', 'Meshy 返回了无法解析的响应。'); }
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new MeshyError('INVALID_RESPONSE', 'Meshy 返回了无效响应。');
    return result;
  } finally { clearTimeout(timer); }
}
function created(result) {
  try { return taskId(result.result); }
  catch { throw new MeshyError('INVALID_RESPONSE', 'Meshy 未返回有效任务编号。'); }
}
// Only selected output formats are passed on. Never fetch arbitrary URLs here.
function safeAssets(urls) {
  const result = {};
  for (const format of ['glb', 'stl']) {
    if (!urls?.[format]) continue;
    try {
      const u = new URL(urls[format]);
      if (u.protocol === 'https:' && u.hostname === 'assets.meshy.ai' && !u.username && !u.password && !u.port)
        result[format] = u.href;
    } catch { /* Drop malformed or unexpected URLs. */ }
  }
  return result;
}
function status(result) {
  const allowed = ['PENDING','IN_PROGRESS','SUCCEEDED','FAILED','CANCELED'];
  if (!ID.test(result.id ?? '') || !allowed.includes(result.status))
    throw new MeshyError('INVALID_RESPONSE', 'Meshy 返回了无效任务状态。');
  return {
    id: result.id, status: result.status,
    progress: typeof result.progress === 'number' && Number.isFinite(result.progress) ? Math.max(0,Math.min(100,result.progress)) : null,
    expiresAt: result.expires_at ?? null,
    assets: safeAssets(result.model_urls),
    // Printability data are provider results, not a guarantee of manufacturability.
    printability: result.printability ?? null,
    error: result.status === 'FAILED' ? '上游任务失败，请检查图片或模型后重试。' : null
  };
}
export async function createImageTo3D(env, imageBytes) {
  keyFrom(env); // fail before encoding photo
  const image_url = imageDataUri(imageBytes);
  const result = await request(env, '/image-to-3d', 'POST', {image_url, ai_model:'meshy-7.1', should_texture:false, should_remesh:true, topology:'triangle', target_polycount:100000, target_formats:['glb','stl']});
  return created(result);
}
export async function getImageTo3D(env, id) {
  return status(await request(env, `/image-to-3d/${taskId(id)}`));
}
export async function createPrintAnalysis(env, sourceTaskId, {printerType, heightMm}) {
  taskId(sourceTaskId);
  if (!['fdm','sla','full_color'].includes(printerType) || typeof heightMm !== 'number' || !Number.isFinite(heightMm) || heightMm < 1 || heightMm > 1000)
    throw new MeshyError('INVALID_INPUT', '打印机类型或成品高度无效。');
  return created(await request(env, '/print/analyze', 'POST', {input_task_id:sourceTaskId,printer_type:printerType,intended_print_height_mm:heightMm}));
}
export async function getPrintAnalysis(env, id) {
  return status(await request(env, `/print/analyze/${taskId(id)}`));
}
// Explicit deletion only: caller must authorize and persist retry state; Meshy returns
// 409 for IN_PROGRESS tasks. Do not equate deletion with verified photo erasure.
export async function deleteImageTask(env, id) {
  return request(env, `/image-to-3d/${taskId(id)}`, 'DELETE');
}
export async function deleteAnalysisTask(env, id) {
  return request(env, `/print/analyze/${taskId(id)}`, 'DELETE');
}
