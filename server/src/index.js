// TimeMark 同步服务端入口（开发/自用版）
// API 契约与《开发计划 v2》§5 一致；正式部署按计划换 Spring Boot + MySQL（云服务器），客户端无感。
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { ServerDB } = require('./db');
const { signJWT, hashPassword, checkPassword, authMiddleware } = require('./auth');
const { registerSyncRoutes } = require('./sync');

const PORT = process.env.PORT || 8787;
const DATA = path.join(__dirname, '..', 'data', 'timemark-server.db');

async function main() {
  const db = new ServerDB(DATA);
  await db.init();
  let secret = db.getMeta('jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    db.setMeta('jwt_secret', secret);
  }

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/v1/health', (_req, res) => res.json({ ok: true, app: 'TimeMark Sync', time: Date.now() }));

  app.post('/api/v1/auth/register', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password || String(password).length < 6) {
      return res.status(400).json({ error: 'invalid_input', message: '用户名不能为空，密码至少 6 位' });
    }
    if (db.get('SELECT id FROM users WHERE username = ?', [String(username)])) {
      return res.status(409).json({ error: 'exists', message: '用户名已存在' });
    }
    const id = crypto.randomUUID();
    db.run('INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)',
      [id, String(username), hashPassword(password), Date.now()]);
    res.json({ token: signJWT({ uid: id, username }, secret), user: { id, username } });
  });

  app.post('/api/v1/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = db.get('SELECT * FROM users WHERE username = ?', [String(username || '')]);
    if (!user || !checkPassword(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'bad_credentials', message: '用户名或密码错误' });
    }
    res.json({ token: signJWT({ uid: user.id, username: user.username }, secret), user: { id: user.id, username: user.username } });
  });

  app.get('/api/v1/me', authMiddleware(secret), (req, res) => {
    res.json({ user: { id: req.auth.userId, username: req.auth.username } });
  });

  registerSyncRoutes(app, db, authMiddleware(secret));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[TimeMark Sync] listening on http://127.0.0.1:${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
