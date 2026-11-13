import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_NAME = 'form3d_session';
export const TEAM_USER = 'self-hosted-admin';
export const SESSION_SECONDS = 8 * 60 * 60;
const digest = value => createHash('sha256').update(value).digest();
export function constantEqual(a, b) { return timingSafeEqual(digest(String(a)), digest(String(b))); }

export function issueSession(secret, now = Date.now()) {
  const data = Buffer.from(JSON.stringify({sub: TEAM_USER, exp: Math.floor(now / 1000) + SESSION_SECONDS})).toString('base64url');
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  return data + '.' + signature;
}
export function verifySession(value, secret, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  const [data, signature, extra] = value.split('.');
  if (!data || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(data + signature)) return null;
  const expected = createHmac('sha256', secret).update(data).digest('base64url');
  if (!constantEqual(signature, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (claims.sub !== TEAM_USER || !Number.isInteger(claims.exp) || claims.exp <= seconds || claims.exp > seconds + SESSION_SECONDS) return null;
    return TEAM_USER;
  } catch { return null; }
}
export function readSession(cookie) {
  if (typeof cookie !== 'string' || cookie.length > 8192) return null;
  const values = cookie.split(';').map(s => s.trim()).filter(s => s.startsWith(SESSION_NAME + '='));
  return values.length === 1 ? values[0].slice(SESSION_NAME.length + 1) : null;
}
export function sessionCookie(value, secure, remove = false) {
  return `${SESSION_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remove ? 0 : SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}

// Socket address only. Arbitrary forwarded headers cannot create fresh buckets.
export function loginLimiter({now = Date.now, max = 10, windowMs = 15 * 60 * 1000} = {}) {
  const buckets = new Map();
  let globalBucket = {until: 0, count: 0};
  return {
    admit(address) {
      const t = now();
      for (const [key, entry] of buckets) if (entry.until <= t) buckets.delete(key);
      if (globalBucket.until <= t) globalBucket = {until: t + windowMs, count: 0};
      if (globalBucket.count >= 100) return false;
      const key = address || 'unknown';
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= 1000) return false;
        bucket = {until: t + windowMs, count: 0}; buckets.set(key, bucket);
      }
      if (bucket.count >= max) return false;
      bucket.count++; globalBucket.count++; return true;
    }
  };
}
