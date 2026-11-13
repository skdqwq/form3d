import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { api as defaultApi } from '../worker/api.mjs';
import { meshyRegion } from '../integration/meshy.mjs';
import { openDatabase } from './database.mjs';
import { constantEqual, issueSession, verifySession, readSession, sessionCookie, loginLimiter } from './auth.mjs';

const MAX_BODY = 12 * 1024 * 1024;
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
const fail = (status, message) => new Response(JSON.stringify({error: message}), {status, headers: {'content-type':'application/json; charset=utf-8'}});
const redirect = (location, headers = {}) => new Response(null, {status:303, headers:{location, ...headers}});
// Normalize only the human-entered team code; cryptographic secrets stay exact.
const normalizeTeamCode = value => typeof value === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value.trim().normalize('NFC') : null;

export function configuration(env = process.env) {
  let origin;
  try { origin = new URL(env.APP_ORIGIN || 'http://127.0.0.1:3103'); } catch { throw new Error('APP_ORIGIN must be a valid origin'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('APP_ORIGIN must contain only scheme and host');
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Public deployments require an HTTPS APP_ORIGIN');
  const invalidSecret = value => typeof value !== 'string' || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value) || /^(change|replace|example|your)/i.test(value);
  const accessCode = normalizeTeamCode(env.FORM3D_ACCESS_TOKEN);
  if (invalidSecret(accessCode) || accessCode.length > 512 || !(/^\p{Script=Han}{3,}$/u.test(accessCode) || (accessCode.length >= 10 && /[A-Za-z]/.test(accessCode) && /[0-9]/.test(accessCode)))) throw new Error('FORM3D_ACCESS_TOKEN must contain at least 3 Chinese characters or at least 10 characters including letters and digits, up to 512 characters; controls and placeholders are not allowed');
  if (invalidSecret(env.SESSION_SECRET) || env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be an independent random secret of at least 32 characters, without control characters, surrounding whitespace or placeholders');
  if (accessCode === env.SESSION_SECRET) throw new Error('Access token and session secret must differ');
  const port = Number(env.PORT || 3103);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return {origin:origin.origin, secure:origin.protocol === 'https:', accessToken:accessCode, sessionSecret:env.SESSION_SECRET, meshyKey:env.MESHY_API_KEY || '', meshyRegion:meshyRegion(env), host:env.HOST || '127.0.0.1', port, database:env.DATABASE_PATH || resolve(ROOT, 'data/form3d.sqlite'), staticDir:resolve(ROOT, 'dist/client')};
}

function loginPage(error = '') {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>形铸团队登录</title><style>body{margin:0;background:#f5f8fc;font:16px/1.6 system-ui,sans-serif;color:#173153}main{max-width:440px;margin:12vh auto;padding:32px;background:white;border:1px solid #d5dfed}h1{font-size:26px}input,button{box-sizing:border-box;width:100%;padding:13px;font:inherit;margin-top:12px}input{border:1px solid #a8bdd7}button{border:0;background:#174e9e;color:white}p{color:#64738a}a{color:#174e9e}.error{color:#a22}</style><main><h1>形铸团队登录</h1><p>工作台和预估报价可公开浏览。生成需算力费用，输入项目组提供的登录码体验。</p><p>登录后的任务记录由项目组共享。</p>${error ? '<p class="error">' + error + '</p>' : ''}<form method="post" action="/auth/login"><label for="token">团队登录码</label><input id="token" name="token" type="password" autocomplete="current-password" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="512"><button type="submit">登录工作台</button></form><p><a href="/">返回工作台</a></p></main></html>`, {headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
}
async function bodyBytes(request, limit = MAX_BODY) {
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw Object.assign(new Error('请求内容过大。'), {status:413});
  const parts=[]; let size=0;
  for await (const part of request) { size += part.length; if (size > limit) throw Object.assign(new Error('请求内容过大。'), {status:413}); parts.push(part); }
  return Buffer.concat(parts, size);
}
function safePath(raw) {
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  const path = raw.split('?')[0];
  let decoded;
  try { decoded=decodeURIComponent(path); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(s => s === '..' || s === '.' || s.startsWith('.'))) return null;
  return decoded;
}

export function createAppServer({config = configuration(), db = openDatabase(config.database), api = defaultApi, now = Date.now} = {}) {
  const limiter=loginLimiter({now});
  const env={DB:db, MESHY_API_KEY:config.meshyKey, MESHY_REGION:config.meshyRegion};
  const sameOrigin=req=>req.headers.origin===config.origin && req.headers['sec-fetch-site']!=='cross-site';
  async function route(req) {
    const pathname=safePath(req.url || '');
    if (!pathname) return fail(400, '请求路径无效。');
    if (req.headers['content-length'] && Number(req.headers['content-length']) > MAX_BODY) return fail(413, '请求内容过大。');
    const user=verifySession(readSession(req.headers.cookie),config.sessionSecret,now());
    if (pathname==='/healthz' && req.method==='GET') return new Response(JSON.stringify({status:'ok'}),{headers:{'content-type':'application/json'}});
    if (pathname==='/signin-with-chatgpt' && req.method==='GET') return redirect('/login');
    if (pathname==='/login' && req.method==='GET') return user ? redirect('/') : loginPage();
    if (pathname==='/logout' && req.method==='GET') return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>退出形铸团队登录</title><body><main><h1>退出团队登录</h1><form method="post" action="/auth/logout"><button type="submit">确认退出</button></form><p><a href="/">返回工作台</a></p></main></body></html>',{headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
    if (pathname==='/auth/login' && req.method==='POST') {
      if (!sameOrigin(req)) return fail(403, '请求来源无效。');
      if (!limiter.admit(req.socket.remoteAddress)) return new Response('登录尝试过多，请15分钟后重试。',{status:429,headers:{'retry-after':'900','content-type':'text/plain; charset=utf-8'}});
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return fail(415,'请求格式无效。');
      // Accommodate URL encoding of the configured 512-character maximum; remain bounded.
      const body=await bodyBytes(req,8192), params=new URLSearchParams(body.toString('utf8'));
      const submittedCode=normalizeTeamCode(params.get('token'));
      if (params.getAll('token').length!==1 || submittedCode===null || !constantEqual(submittedCode,config.accessToken)) return new Response(await loginPage('登录码不正确。').text(),{status:401,headers:loginPage().headers});
      return redirect('/',{'set-cookie':sessionCookie(issueSession(config.sessionSecret,now()),config.secure)});
    }
    if (pathname==='/auth/logout' && req.method==='POST') {
      if (!sameOrigin(req)) return fail(403,'请求来源无效。');
      return redirect('/login',{'set-cookie':sessionCookie('',config.secure,true)});
    }
    if (pathname.startsWith('/api/')) {
      if (!['GET','POST'].includes(req.method)) return fail(405,'请求方法不支持。');
      const headers=new Headers();
      for (const key of ['origin','content-type','sec-fetch-site']) if (typeof req.headers[key]==='string') headers.set(key,req.headers[key]);
      // Never forward client authentication/forwarded headers to the Worker API.
      if (user) headers.set('oai-authenticated-user-id',user);
      if (req.method==='POST' && !sameOrigin(req)) return fail(403,'请求来源无效。');
      if (req.method==='POST' && !user) return fail(401,'请先登录。');
      const body=req.method==='POST' ? await bodyBytes(req) : undefined;
      const request=new Request(config.origin + req.url, {method:req.method,headers,...(body ? {body} : {})});
      return await api(request,env) || fail(404,'未找到接口。');
    }
    if (!['GET','HEAD'].includes(req.method)) return fail(405,'请求方法不支持。');
    const filename=resolve(config.staticDir,'.' + (pathname==='/' ? '/index.html' : pathname));
    const root=await realpath(config.staticDir);
    let actual;
    try { actual=await realpath(filename); } catch { return fail(404,'未找到文件。'); }
    if (!actual.startsWith(root + sep)) return fail(403,'无法访问此路径。');
    const info=await stat(actual);
    if (!info.isFile()) return fail(404,'未找到文件。');
    const type=TYPES[extname(actual).toLowerCase()];
    if (!type) return fail(404,'未找到文件。');
    return new Response(req.method==='HEAD' ? null : Readable.toWeb(createReadStream(actual)),{headers:{'content-type':type,'content-length':String(info.size),'cache-control':pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'}});
  }
  const server=createServer(async(req,res)=>{
    try {
      const response=await route(req);
      response.headers.set('x-content-type-options','nosniff');
      response.headers.set('referrer-policy','no-referrer');
      response.headers.set('x-frame-options','DENY');
      if (!response.headers.has('cache-control')) response.headers.set('cache-control','no-store');
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if (response.body && req.method!=='HEAD') await pipeline(Readable.fromWeb(response.body),res); else res.end();
      if (!req.complete) req.resume();
    } catch(error) {
      if (!res.headersSent) { res.writeHead(error.status || 500,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify({error:error.status===413?'请求内容过大。':'服务暂时无法处理请求。'})); } else res.destroy();
      if (!req.complete) req.resume();
      // Deliberately omit request headers, URLs, bodies and exception contents.
    }
  });
  server.headersTimeout=15000;
  server.requestTimeout=30000;
  server.timeout=120000;
  server.keepAliveTimeout=5000;
  server.maxRequestsPerSocket=100;
  return {server,db};
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const config=configuration(), {server,db}=createAppServer({config});
    server.listen(config.port,config.host,()=>console.log(`FORM3D listening on ${config.host}:${config.port}`));
    let stopping=false;
    const stop=()=>{if(stopping)return;stopping=true;server.close(()=>{db.close();process.exit(0)});setTimeout(()=>process.exit(1),10000).unref()};
    process.on('SIGTERM',stop);process.on('SIGINT',stop);
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
