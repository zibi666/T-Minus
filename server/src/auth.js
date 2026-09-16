// 认证：scrypt 口令哈希 + HS256 JWT（仅用 Node 内置 crypto，零额外依赖）
const crypto = require('crypto');

const TOKEN_TTL_SEC = 7 * 24 * 3600; // §1：JWT 7 天有效

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signJWT(payload, secret) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC
  }));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expect = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(expect);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    if (!payload.exp || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  const a = Buffer.from(h);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Express 中间件：校验 Bearer token，挂载 req.auth = { userId, username } */
function authMiddleware(secret) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token ? verifyJWT(token, secret) : null;
    if (!payload || !payload.uid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.auth = { userId: payload.uid, username: payload.username };
    next();
  };
}

module.exports = { signJWT, verifyJWT, hashPassword, checkPassword, authMiddleware, TOKEN_TTL_SEC };
